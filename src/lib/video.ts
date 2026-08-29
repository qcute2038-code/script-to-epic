/**
 * Video engine.
 *
 * Long scripts (100k+ chars -> 2h+ of runtime, thousands of shots) cannot be
 * encoded with ffmpeg.wasm: a single filter_complex with thousands of inputs
 * blows past the wasm heap and the software x264 encoder needs many hours.
 *
 * This engine instead renders every frame on a canvas and encodes with
 * WebCodecs (hardware H.264), muxing straight into an mp4. Memory stays flat:
 * one image in, one frame out, and — when the browser supports the File System
 * Access API — the mp4 is streamed to disk instead of being held in RAM, so a
 * multi-gigabyte 2-hour render never has to fit in memory.
 */

import { Muxer, ArrayBufferTarget, StreamTarget } from "mp4-muxer";

export type Shot = { url: string; start: number; end: number; prompt?: string | undefined };

export type BuildResult =
  | { kind: "blob"; blob: Blob }
  | { kind: "file"; fileName: string };

const W = 1920;
const H = 1080;
const FPS = 30;
/** Cross-fade length between two shots (seconds). */
const XF = 0.7;
/** Keyframe interval (seconds) — keeps the mp4 seekable without bloating it. */
const GOP = 2;

export function webCodecsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.VideoEncoder === "function";
}

/* ------------------------------------------------------------------ */
/* Cinematography                                                      */
/* ------------------------------------------------------------------ */

function hash(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type Move = { z0: number; z1: number; x0: number; x1: number; y0: number; y1: number };

/** Ken Burns moves: start/end zoom plus start/end focal point (0..1). */
const MOVES: Move[] = [
  { z0: 1.0, z1: 1.2, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 }, // push in
  { z0: 1.22, z1: 1.0, x0: 0.5, x1: 0.5, y0: 0.5, y1: 0.5 }, // pull back
  { z0: 1.14, z1: 1.14, x0: 0.0, x1: 1.0, y0: 0.5, y1: 0.5 }, // pan L->R
  { z0: 1.14, z1: 1.14, x0: 1.0, x1: 0.0, y0: 0.5, y1: 0.5 }, // pan R->L
  { z0: 1.14, z1: 1.14, x0: 0.5, x1: 0.5, y0: 0.0, y1: 1.0 }, // tilt down
  { z0: 1.14, z1: 1.14, x0: 0.5, x1: 0.5, y0: 1.0, y1: 0.0 }, // tilt up
  { z0: 1.02, z1: 1.24, x0: 0.3, x1: 0.28, y0: 0.3, y1: 0.22 }, // push to face TL
  { z0: 1.02, z1: 1.24, x0: 0.7, x1: 0.72, y0: 0.7, y1: 0.78 }, // push to BR
  { z0: 1.08, z1: 1.22, x0: 0.15, x1: 0.85, y0: 0.85, y1: 0.15 }, // diagonal drift
];

type Grade = { filter: string; tint: string; tintAlpha: number };

const GRADES = {
  night: { filter: "contrast(1.14) brightness(0.955) saturate(1.05)", tint: "#2a4a8f", tintAlpha: 0.14 },
  sunset: { filter: "contrast(1.10) brightness(1.02) saturate(1.30)", tint: "#ff8a3d", tintAlpha: 0.12 },
  warm: { filter: "contrast(1.08) brightness(1.015) saturate(1.22)", tint: "#ffb066", tintAlpha: 0.08 },
  cool: { filter: "contrast(1.10) brightness(1.0) saturate(1.12)", tint: "#5fa8ff", tintAlpha: 0.09 },
  tense: { filter: "contrast(1.26) brightness(0.97) saturate(0.92)", tint: "#7a2020", tintAlpha: 0.08 },
  rain: { filter: "contrast(1.12) brightness(0.98) saturate(0.95)", tint: "#4f7fb5", tintAlpha: 0.12 },
  bright: { filter: "contrast(1.06) brightness(1.035) saturate(1.28)", tint: "#fff2cc", tintAlpha: 0.05 },
  dream: { filter: "contrast(1.02) brightness(1.03) saturate(1.34)", tint: "#ffb8e6", tintAlpha: 0.07 },
} satisfies Record<string, Grade>;

const CYCLE = ["bright", "warm", "cool", "dream", "tense"];

function gradeFor(shot: Shot, i: number): Grade {
  const t = (shot.prompt ?? "").toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  if (has("night", "midnight", "moon", "dark room", "starlit", "streetlight")) return GRADES.night!;
  if (has("sunset", "dusk", "golden hour", "sunrise", "dawn", "fire", "flame", "lantern"))
    return GRADES.sunset!;
  if (has("rain", "storm", "wet", "monsoon", "fog", "mist")) return GRADES.rain!;
  if (has("angry", "fight", "blood", "scream", "fear", "shadow", "threat", "battle"))
    return GRADES.tense!;
  if (has("sunlight", "sunny", "morning", "market", "festival", "smile", "laugh"))
    return GRADES.bright!;
  if (has("memory", "dream", "flashback", "sky", "hope", "magic")) return GRADES.dream!;
  if (has("indoor", "room", "kitchen", "lamp", "warm")) return GRADES.warm!;
  if (has("cold", "rooftop", "hospital", "office", "school", "train")) return GRADES.cool!;
  return (GRADES as Record<string, Grade>)[CYCLE[i % CYCLE.length] as string]!;
}

/* ------------------------------------------------------------------ */
/* Image loading                                                       */
/* ------------------------------------------------------------------ */

async function loadBitmap(url: string, attempts = 3): Promise<ImageBitmap> {
  let last = "";
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 400 * (a + 1)));
    }
  }
  throw new Error(`Could not load panel image: ${last}`);
}

function drawKenBurns(
  ctx: CanvasRenderingContext2D,
  img: ImageBitmap,
  move: Move,
  p: number,
  grade: Grade,
  alpha: number,
) {
  const t = Math.min(1, Math.max(0, p));
  // ease-in-out so the camera never starts or stops abruptly
  const e = t * t * (3 - 2 * t);
  const zoom = move.z0 + (move.z1 - move.z0) * e;
  const fx = move.x0 + (move.x1 - move.x0) * e;
  const fy = move.y0 + (move.y1 - move.y0) * e;

  // cover-fit the source into 16:9, then crop the zoom window inside it
  const target = W / H;
  const src = img.width / img.height;
  let cw = img.width;
  let ch = img.height;
  if (src > target) cw = img.height * target;
  else ch = img.width / target;

  const vw = cw / zoom;
  const vh = ch / zoom;
  const ox = (img.width - cw) / 2 + (cw - vw) * fx;
  const oy = (img.height - ch) / 2 + (ch - vh) * fy;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.filter = grade.filter;
  ctx.drawImage(img, ox, oy, vw, vh, 0, 0, W, H);
  ctx.filter = "none";
  // colour balance pass
  ctx.globalAlpha = alpha * grade.tintAlpha;
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = grade.tint;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

type Opts = {
  /** Stream straight to a user-chosen file (required for very long videos). */
  fileHandle?: FileSystemFileHandle | undefined;
  /** Encoded width; long videos may be rendered at 1280x720 to stay realtime. */
  width?: number;
  height?: number;
  bitrate?: number;
};

export async function buildVideo(
  shots: Shot[],
  onProgress: (pct: number, note: string) => void,
  opts: Opts = {},
): Promise<BuildResult> {
  if (shots.length === 0) throw new Error("No panels to render.");
  if (!webCodecsSupported())
    throw new Error(
      "This browser cannot encode video. Use the latest Chrome, Edge or Opera on desktop.",
    );

  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const bitrate = opts.bitrate ?? (width >= 1920 ? 8_000_000 : 4_500_000);

  const durations = shots.map((s) => Math.max(0.8, s.end - s.start));
  const totalSeconds = durations.reduce((a, b) => a + b, 0);
  const totalFrames = Math.max(1, Math.round(totalSeconds * FPS));

  onProgress(1, "Starting encoder…");

  // ---- muxer target: stream to disk when we have a file handle -------------
  let writable: FileSystemWritableFileStream | null = null;
  let muxer: Muxer<ArrayBufferTarget | StreamTarget>;

  if (opts.fileHandle) {
    writable = await opts.fileHandle.createWritable();
    const w = writable;
    muxer = new Muxer({
      target: new StreamTarget({
        onData: (data, position) => {
          void w.write({ type: "write", data: data.slice() as unknown as BufferSource, position });
        },
        chunked: true,
      }),
      video: { codec: "avc", width, height },
      fastStart: false,
    }) as Muxer<StreamTarget>;
  } else {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height },
      fastStart: "in-memory",
    }) as Muxer<ArrayBufferTarget>;
  }

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });

  // Level 4.2 handles 1080p30; fall back to a lower profile if unsupported.
  const codecCandidates = ["avc1.42003e", "avc1.4d0034", "avc1.640034", "avc1.42001f"];
  let configured = false;
  for (const codec of codecCandidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: FPS,
      });
      if (!support.supported) continue;
      encoder.configure({
        codec,
        width,
        height,
        bitrate,
        framerate: FPS,
        latencyMode: "quality",
      });
      configured = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!configured) throw new Error("No supported H.264 encoder configuration in this browser.");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
  if (!ctx) throw new Error("Could not create a rendering canvas.");
  ctx.imageSmoothingQuality = "high";

  // Ken Burns math is written against a 1920x1080 stage; scale the draw calls.
  const sx = width / W;
  const sy = height / H;

  let frameIndex = 0;
  const started = Date.now();
  let lastNote = 0;

  const flushGate = async () => {
    while (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4));
    }
  };

  // pick a distinct camera move per shot
  const moves: Move[] = [];
  let lastMove = -1;
  for (let i = 0; i < shots.length; i++) {
    let mi = Math.floor(hash(i, 3) * MOVES.length) % MOVES.length;
    if (mi === lastMove) mi = (mi + 1 + Math.floor(hash(i, 9) * 3)) % MOVES.length;
    lastMove = mi;
    moves.push(MOVES[mi]!);
  }

  let current: ImageBitmap | null = null;
  let next: Promise<ImageBitmap> | null = null;

  try {
    current = await loadBitmap(shots[0]!.url);

    for (let i = 0; i < shots.length; i++) {
      if (encoderError) throw encoderError;

      const dur = durations[i]!;
      const frames = Math.max(1, Math.round(dur * FPS));
      const grade = gradeFor(shots[i]!, i);
      const move = moves[i]!;

      // prefetch the next panel while this one renders
      next = i + 1 < shots.length ? loadBitmap(shots[i + 1]!.url) : null;
      let incoming: ImageBitmap | null = null;
      let incomingReady = false;
      if (next) {
        void next
          .then((b) => {
            incoming = b;
            incomingReady = true;
          })
          .catch(() => {
            incomingReady = true;
          });
      }

      const fadeStart = Math.max(0, dur - XF);

      for (let f = 0; f < frames; f++) {
        const t = f / FPS;
        // the shot's own move runs over its duration plus the outgoing fade
        const p = t / (dur + (i < shots.length - 1 ? XF : 0));

        ctx.save();
        ctx.scale(sx, sy);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
        drawKenBurns(ctx, current!, move, p, grade, 1);

        if (i < shots.length - 1 && t >= fadeStart) {
          if (!incomingReady) {
            // the next image is still downloading — wait rather than skip it
            await next!.then(
              (b) => {
                incoming = b;
                incomingReady = true;
              },
              () => {
                incomingReady = true;
              },
            );
          }
          if (incoming) {
            const a = Math.min(1, (t - fadeStart) / XF);
            const nMove = moves[i + 1]!;
            const nGrade = gradeFor(shots[i + 1]!, i + 1);
            const nDur = durations[i + 1]! + XF;
            drawKenBurns(ctx, incoming, nMove, (t - fadeStart) / nDur, nGrade, a);
          }
        }
        ctx.restore();

        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((frameIndex * 1_000_000) / FPS),
          duration: Math.round(1_000_000 / FPS),
        });
        await flushGate();
        encoder.encode(frame, { keyFrame: frameIndex % (FPS * GOP) === 0 });
        frame.close();
        frameIndex++;

        if (Date.now() - lastNote > 400) {
          lastNote = Date.now();
          const pct = frameIndex / totalFrames;
          const elapsed = (Date.now() - started) / 1000;
          const eta = pct > 0.002 ? Math.round(elapsed / pct - elapsed) : 0;
          onProgress(
            Math.min(99, Math.round(pct * 100)),
            `Encoding ${Math.round(pct * 100)}% · shot ${i + 1}/${shots.length}` +
              (eta ? ` · ~${fmtEta(eta)} left` : ""),
          );
          // yield to the UI thread
          await new Promise((r) => setTimeout(r, 0));
        }
        if (encoderError) throw encoderError;
      }

      current?.close();
      current = incoming ?? (next ? await next.catch(() => null) : null);
      if (!current && i + 1 < shots.length) {
        // this panel's image is unusable — skip to the following one
        current = await loadBitmap(shots[i + 1]!.url).catch(() => null as unknown as ImageBitmap);
        if (!current) throw new Error(`Panel ${i + 2} image could not be loaded.`);
      }
    }

    onProgress(99, "Finalising file…");
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();

    if (writable) {
      await writable.close();
      onProgress(100, "Video saved");
      return { kind: "file", fileName: opts.fileHandle!.name };
    }

    const target = muxer.target as ArrayBufferTarget;
    onProgress(100, "Video ready");
    return {
      kind: "blob",
      blob: new Blob([target.buffer as ArrayBuffer], { type: "video/mp4" }),
    };
  } catch (e) {
    try {
      encoder.close();
    } catch {
      /* already closed */
    }
    if (writable) await writable.close().catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    current?.close();
  }
}

function fmtEta(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
