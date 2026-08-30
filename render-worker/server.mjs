/**
 * Scene Weaver render worker.
 *
 * Runs on the user's own EC2 box. Takes a list of panels (image URL + start/end
 * seconds + prompt) and produces a finished MP4 entirely server-side with
 * ffmpeg: Ken Burns move per panel, colour grade per panel, cross-fades
 * between panels. No S3 — the finished file is served from local disk.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RENDER_TOKEN || "";
const ROOT = process.env.RENDER_DIR || "/var/lib/scene-weaver";
const OUT = path.join(ROOT, "out");
const WORK = path.join(ROOT, "work");
await fsp.mkdir(OUT, { recursive: true });
await fsp.mkdir(WORK, { recursive: true });

const FPS = 30;
const XF = 0.7; // cross-fade seconds
const CHUNK = 24; // panels merged per xfade pass
const CPUS = Math.max(1, os.cpus().length);
const LANES = Math.max(1, Math.min(4, CPUS)); // parallel segment encodes

/* ---------------- job store ---------------- */

const jobs = new Map(); // id -> {id,status,progress,note,error,file,total,createdAt}
const queue = [];
let running = false;

function setJob(id, patch) {
  const j = jobs.get(id);
  if (j) Object.assign(j, patch, { updatedAt: Date.now() });
}

/* ---------------- helpers ---------------- */

function run(bin, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      const s = String(d);
      err = (err + s).slice(-4000);
      if (onLine) onLine(s);
    });
    p.stdout.on("data", () => {});
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

async function download(url, dest, attempts = 4) {
  let last = "";
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error("empty image");
      await fsp.writeFile(dest, buf);
      return;
    } catch (e) {
      last = e?.message || String(e);
      await new Promise((r) => setTimeout(r, 500 * (a + 1)));
    }
  }
  throw new Error(`download failed: ${last}`);
}

/* ---------------- cinematography ---------------- */

const MOVES = [
  { z0: 1.0, z1: 1.2, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 },
  { z0: 1.22, z1: 1.0, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 },
  { z0: 1.14, z1: 1.14, x0: 0.0, x1: 1.0, y0: 0.5, y1: 0.5 },
  { z0: 1.14, z1: 1.14, x0: 1.0, x1: 0.0, y0: 0.5, y1: 0.5 },
  { z0: 1.14, z1: 1.14, x0: 0.5, x1: 0.5, y0: 0.0, y1: 1.0 },
  { z0: 1.14, z1: 1.14, x0: 0.5, x1: 0.5, y0: 1.0, y1: 0.0 },
  { z0: 1.02, z1: 1.24, x0: 0.3, x1: 0.28, y0: 0.3, y1: 0.22 },
  { z0: 1.02, z1: 1.24, x0: 0.7, x1: 0.72, y0: 0.7, y1: 0.78 },
  { z0: 1.08, z1: 1.22, x0: 0.15, x1: 0.85, y0: 0.85, y1: 0.15 },
];

// eq + rgb tint, mirroring the browser grades
const GRADES = {
  night: { c: 1.14, b: -0.045, s: 1.05, r: 0.96, g: 0.98, bl: 1.08 },
  sunset: { c: 1.1, b: 0.02, s: 1.3, r: 1.08, g: 1.0, bl: 0.93 },
  warm: { c: 1.08, b: 0.015, s: 1.22, r: 1.05, g: 1.0, bl: 0.95 },
  cool: { c: 1.1, b: 0, s: 1.12, r: 0.96, g: 1.0, bl: 1.07 },
  tense: { c: 1.26, b: -0.03, s: 0.92, r: 1.06, g: 0.96, bl: 0.96 },
  rain: { c: 1.12, b: -0.02, s: 0.95, r: 0.95, g: 1.0, bl: 1.08 },
  bright: { c: 1.06, b: 0.035, s: 1.28, r: 1.02, g: 1.01, bl: 0.98 },
  dream: { c: 1.02, b: 0.03, s: 1.34, r: 1.05, g: 0.98, bl: 1.04 },
};
const CYCLE = ["bright", "warm", "cool", "dream", "tense"];

function gradeFor(prompt, i) {
  const t = (prompt || "").toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  if (has("night", "midnight", "moon", "dark room", "starlit", "streetlight")) return GRADES.night;
  if (has("sunset", "dusk", "golden hour", "sunrise", "dawn", "fire", "flame", "lantern"))
    return GRADES.sunset;
  if (has("rain", "storm", "wet", "monsoon", "fog", "mist")) return GRADES.rain;
  if (has("angry", "fight", "blood", "scream", "fear", "shadow", "threat", "battle"))
    return GRADES.tense;
  if (has("sunlight", "sunny", "morning", "market", "festival", "smile", "laugh"))
    return GRADES.bright;
  if (has("memory", "dream", "flashback", "sky", "hope", "magic")) return GRADES.dream;
  if (has("indoor", "room", "kitchen", "lamp", "warm")) return GRADES.warm;
  if (has("cold", "rooftop", "hospital", "office", "school", "train")) return GRADES.cool;
  return GRADES[CYCLE[i % CYCLE.length]];
}

function moveFor(i) {
  const h = (s) => {
    const x = Math.sin((i + 1) * 12.9898 + s * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return MOVES[Math.floor(h(3) * MOVES.length) % MOVES.length];
}

/**
 * Ken Burns segment for one panel. zoompan is fed an upscaled still so the
 * zoom never shows interpolation stepping; output is exactly `frames` long.
 */
function segmentFilter(move, grade, frames, W, H) {
  const e = `(3-2*(on/${frames}))*(on/${frames})*(on/${frames})`; // smoothstep
  const z = `${move.z0}+(${move.z1 - move.z0})*(${e})`;
  const fx = `${move.x0}+(${move.x1 - move.x0})*(${e})`;
  const fy = `${move.y0}+(${move.y1 - move.y0})*(${e})`;
  const up = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`;
  const zp =
    `zoompan=z='${z}':x='(iw-iw/zoom)*(${fx})':y='(ih-ih/zoom)*(${fy})'` +
    `:d=${frames}:s=${W}x${H}:fps=${FPS}`;
  const col =
    `eq=contrast=${grade.c}:brightness=${grade.b}:saturation=${grade.s},` +
    `colorchannelmixer=rr=${grade.r}:gg=${grade.g}:bb=${grade.bl}`;
  return `${up},${zp},${col},format=yuv420p`;
}

async function encodeSegment(img, out, move, grade, seconds, W, H, crf, preset) {
  const frames = Math.max(2, Math.round(seconds * FPS));
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-i",
    img,
    "-t",
    String(seconds),
    "-filter_complex",
    segmentFilter(move, grade, frames, W, H),
    "-frames:v",
    String(frames),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-an",
    out,
  ]);
}

/** Cross-fades a list of clips into one file. */
async function xfadeMerge(files, durations, out, crf, preset) {
  if (files.length === 1) {
    await fsp.copyFile(files[0], out);
    return durations[0];
  }
  const inputs = [];
  for (const f of files) inputs.push("-i", f);
  let filter = "";
  let prev = "0:v";
  let offset = durations[0] - XF;
  for (let i = 1; i < files.length; i++) {
    const label = i === files.length - 1 ? "out" : `v${i}`;
    filter += `[${prev}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${label}];`;
    prev = label;
    offset += durations[i] - XF;
  }
  filter = filter.replace(/;$/, "");
  const total = durations.reduce((a, b) => a + b, 0) - XF * (files.length - 1);
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-an",
    out,
  ]);
  return total;
}

/* ---------------- the job ---------------- */

async function runJob(job) {
  const { id, shots, W, H, crf, preset } = job;
  const dir = path.join(WORK, id);
  await fsp.mkdir(dir, { recursive: true });
  const n = shots.length;
  const started = Date.now();

  const dur = shots.map((s) => Math.max(0.8, (s.end ?? 0) - (s.start ?? 0)));
  // every clip but the last carries the outgoing cross-fade overlap
  const segDur = dur.map((d, i) => (i < n - 1 ? d + XF : d));

  setJob(id, { status: "running", note: "Downloading panels…", progress: 1 });

  const segs = new Array(n);
  let done = 0;
  const tick = (note) => {
    const pct = Math.min(88, Math.round((done / n) * 88));
    const el = (Date.now() - started) / 1000;
    const eta = done > 2 ? Math.round((el / done) * (n - done)) : 0;
    setJob(id, { progress: Math.max(1, pct), note: `${note}${eta ? ` · ~${fmt(eta)} left` : ""}` });
  };

  let cursor = 0;
  async function lane() {
    for (;;) {
      const i = cursor++;
      if (i >= n) return;
      const img = path.join(dir, `p${i}.img`);
      const seg = path.join(dir, `s${String(i).padStart(6, "0")}.mp4`);
      await download(shots[i].url, img);
      await encodeSegment(img, seg, moveFor(i), gradeFor(shots[i].prompt, i), segDur[i], W, H, crf, preset);
      await fsp.rm(img, { force: true });
      segs[i] = seg;
      done++;
      tick(`Rendering panel ${done}/${n}`);
    }
  }
  await Promise.all(Array.from({ length: LANES }, lane));

  // hierarchical cross-fade merge so ffmpeg never sees thousands of inputs
  setJob(id, { progress: 90, note: "Stitching cross-fades…" });
  let level = segs;
  let levelDur = segDur.slice();
  let pass = 0;
  while (level.length > 1) {
    const next = [];
    const nextDur = [];
    for (let i = 0; i < level.length; i += CHUNK) {
      const grp = level.slice(i, i + CHUNK);
      const gd = levelDur.slice(i, i + CHUNK);
      const out = path.join(dir, `m${pass}_${i}.mp4`);
      nextDur.push(await xfadeMerge(grp, gd, out, crf, preset));
      next.push(out);
      setJob(id, {
        progress: Math.min(98, 90 + pass),
        note: `Stitching ${Math.min(i + CHUNK, level.length)}/${level.length}`,
      });
    }
    for (const f of level) await fsp.rm(f, { force: true });
    level = next;
    levelDur = nextDur;
    pass++;
  }

  const final = path.join(OUT, `${id}.mp4`);
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    level[0],
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    final,
  ]);
  await fsp.rm(dir, { recursive: true, force: true });
  const stat = await fsp.stat(final);
  setJob(id, {
    status: "done",
    progress: 100,
    note: "Video ready",
    file: final,
    bytes: stat.size,
    url: `/download/${id}.mp4`,
  });
}

function fmt(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await runJob(job);
    } catch (e) {
      setJob(job.id, {
        status: "error",
        error: e?.message || String(e),
        note: "Render failed",
      });
      await fsp.rm(path.join(WORK, job.id), { recursive: true, force: true }).catch(() => {});
    }
  }
  running = false;
}

/* ---------------- http ---------------- */

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-render-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return json(res, 204, {});

  if (url.pathname === "/health") return json(res, 200, { ok: true, cpus: CPUS, queue: queue.length });

  // download is token-free but unguessable (uuid), so the browser can stream it
  if (req.method === "GET" && url.pathname.startsWith("/download/")) {
    const name = path.basename(url.pathname);
    if (!/^[0-9a-f-]{36}\.mp4$/.test(name)) return json(res, 400, { error: "bad name" });
    const file = path.join(OUT, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
    const stat = fs.statSync(file);
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": stat.size,
      "content-disposition": `attachment; filename="scene-weaver.mp4"`,
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (TOKEN && req.headers["x-render-token"] !== TOKEN)
    return json(res, 401, { error: "unauthorized" });

  if (req.method === "POST" && url.pathname === "/jobs") {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 80_000_000) return json(res, 413, { error: "payload too large" });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    const shots = Array.isArray(body?.shots) ? body.shots : [];
    if (!shots.length || !shots.every((s) => typeof s?.url === "string"))
      return json(res, 400, { error: "shots[] required" });
    const id = randomUUID();
    const job = {
      id,
      shots,
      W: body.width === 1280 ? 1280 : 1920,
      H: body.width === 1280 ? 720 : 1080,
      crf: Number.isFinite(body.crf) ? Math.min(30, Math.max(16, body.crf)) : 20,
      preset: typeof body.preset === "string" ? body.preset : "veryfast",
      status: "queued",
      progress: 0,
      note: "Queued",
      total: shots.length,
      createdAt: Date.now(),
    };
    jobs.set(id, job);
    queue.push(job);
    void pump();
    return json(res, 200, { id });
  }

  if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const j = jobs.get(url.pathname.slice(6));
    if (!j) return json(res, 404, { error: "not found" });
    return json(res, 200, {
      id: j.id,
      status: j.status,
      progress: j.progress,
      note: j.note,
      error: j.error ?? null,
      total: j.total,
      bytes: j.bytes ?? null,
      url: j.url ?? null,
    });
  }

  return json(res, 404, { error: "not found" });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(PORT, () => console.log(`render worker on :${PORT} (${CPUS} cpus, ${LANES} lanes)`));

// housekeeping: drop finished files after 24h
setInterval(
  async () => {
    const cut = Date.now() - 24 * 3600_000;
    for (const [id, j] of jobs) {
      if ((j.updatedAt ?? j.createdAt) < cut) {
        jobs.delete(id);
        await fsp.rm(path.join(OUT, `${id}.mp4`), { force: true }).catch(() => {});
      }
    }
  },
  3600_000,
).unref?.();

void createHash; // keep node happy about unused import in some linters
