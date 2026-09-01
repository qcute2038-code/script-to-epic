"""
Scene Weaver — Colab T4 GPU encoder.

Runs inside a Google Colab notebook (GPU runtime). Accepts a panel list from
the web app, downloads every panel image, renders Ken Burns motion + colour
grading with ffmpeg, encodes with the T4's NVENC hardware encoder and serves
the finished mp4 back over an https tunnel.

Design notes for very long videos (2h+, thousands of panels):
  * Each panel becomes its own short clip -> memory stays flat.
  * Clips are cross-faded in groups (GROUP panels per filter_complex) so the
    ffmpeg command never grows unbounded, then the groups are stream-copy
    concatenated: no generation loss, no O(n^2) re-encoding.
  * Panels are rendered in parallel lanes; NVENC on a T4 handles several
    1080p30 streams at once.
"""

import json, math, os, re, shutil, subprocess, threading, time, uuid, hashlib
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import urllib.request

W, H, FPS, XF, GROUP = 1920, 1080, 30, 0.7, 40
WORK = "/content/sw_work"
OUT = "/content/sw_out"
LANES = int(os.environ.get("SW_LANES", "4"))
TOKEN = os.environ.get("SW_TOKEN", "")

os.makedirs(WORK, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

JOBS = {}
LOCK = threading.Lock()

# ---------------------------------------------------------------- encoder ---

def has_nvenc():
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                             capture_output=True, text=True).stdout
        return "h264_nvenc" in out
    except Exception:
        return False

NVENC = has_nvenc()
VCODEC = (["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "8M"]
          if NVENC else
          ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"])

# --------------------------------------------------------- cinematography ---

MOVES = [
    (1.00, 1.20, 0.5, 0.5, 0.5, 0.5),
    (1.22, 1.00, 0.5, 0.5, 0.5, 0.5),
    (1.14, 1.14, 0.0, 1.0, 0.5, 0.5),
    (1.14, 1.14, 1.0, 0.0, 0.5, 0.5),
    (1.14, 1.14, 0.5, 0.5, 0.0, 1.0),
    (1.14, 1.14, 0.5, 0.5, 1.0, 0.0),
    (1.02, 1.24, 0.3, 0.28, 0.3, 0.22),
    (1.02, 1.24, 0.7, 0.72, 0.7, 0.78),
    (1.08, 1.22, 0.15, 0.85, 0.85, 0.15),
]

GRADES = {
    "night":  ("1.14", "-0.045", "1.05", "0.10:0.02:-0.10"),
    "sunset": ("1.10", "0.02", "1.30", "0.10:0.01:-0.08"),
    "warm":   ("1.08", "0.015", "1.22", "0.06:0.00:-0.05"),
    "cool":   ("1.10", "0.0", "1.12", "-0.06:0.00:0.07"),
    "tense":  ("1.26", "-0.03", "0.92", "0.07:-0.02:-0.03"),
    "rain":   ("1.12", "-0.02", "0.95", "-0.05:0.00:0.08"),
    "bright": ("1.06", "0.035", "1.28", "0.03:0.01:-0.02"),
    "dream":  ("1.02", "0.03", "1.34", "0.05:-0.01:0.05"),
}
CYCLE = ["bright", "warm", "cool", "dream", "tense"]

KEYS = [
    ("night", ["night", "midnight", "moon", "dark room", "starlit", "streetlight"]),
    ("sunset", ["sunset", "dusk", "golden hour", "sunrise", "dawn", "fire", "flame", "lantern"]),
    ("rain", ["rain", "storm", "wet", "monsoon", "fog", "mist"]),
    ("tense", ["angry", "fight", "blood", "scream", "fear", "shadow", "threat", "battle"]),
    ("bright", ["sunlight", "sunny", "morning", "market", "festival", "smile", "laugh"]),
    ("dream", ["memory", "dream", "flashback", "sky", "hope", "magic"]),
    ("warm", ["indoor", "room", "kitchen", "lamp", "warm"]),
    ("cool", ["cold", "rooftop", "hospital", "office", "school", "train"]),
]


def grade_for(prompt, i):
    t = (prompt or "").lower()
    for name, words in KEYS:
        if any(w in t for w in words):
            return GRADES[name]
    return GRADES[CYCLE[i % len(CYCLE)]]


def move_for(i):
    h = int(hashlib.md5(f"m{i}".encode()).hexdigest()[:8], 16)
    return MOVES[h % len(MOVES)]


def clip_filter(i, dur, prompt):
    """zoompan Ken Burns + colour grade, always output exact 16:9 1080p."""
    z0, z1, x0, x1, y0, y1 = move_for(i)
    frames = max(1, round(dur * FPS))
    contrast, bright, sat, cb = grade_for(prompt, i)
    # progress 0..1 across the clip, eased
    p = f"(on/{max(1, frames - 1)})"
    e = f"({p}*{p}*(3-2*{p}))"
    z = f"({z0}+({z1}-{z0})*{e})"
    fx = f"({x0}+({x1}-{x0})*{e})"
    fy = f"({y0}+({y1}-{y0})*{e})"
    return (
        f"scale={W*2}:{H*2}:force_original_aspect_ratio=increase,"
        f"crop={W*2}:{H*2},setsar=1,"
        f"zoompan=z='{z}':x='(iw-iw/zoom)*{fx}':y='(ih-ih/zoom)*{fy}'"
        f":d={frames}:s={W}x{H}:fps={FPS},"
        f"eq=contrast={contrast}:brightness={bright}:saturation={sat},"
        f"colorbalance=rm={cb.split(':')[0]}:gm={cb.split(':')[1]}:bm={cb.split(':')[2]},"
        f"format=yuv420p"
    )


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-1500:])


def fetch(url, path, attempts=4):
    last = ""
    for a in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "scene-weaver-colab"})
            with urllib.request.urlopen(req, timeout=90) as r, open(path, "wb") as f:
                shutil.copyfileobj(r, f)
            if os.path.getsize(path) > 0:
                return
            last = "empty file"
        except Exception as e:
            last = str(e)
        time.sleep(0.6 * (a + 1))
    raise RuntimeError(f"download failed: {last}")


# ------------------------------------------------------------------- job ---

def set_job(jid, **kw):
    with LOCK:
        JOBS[jid].update(kw)


def render(jid, panels):
    d = os.path.join(WORK, jid)
    os.makedirs(d, exist_ok=True)
    n = len(panels)
    done = [0]

    def one(i):
        p = panels[i]
        dur = max(0.8, float(p["end"]) - float(p["start"]))
        # crossfade needs XF extra seconds of tail on every clip but the last
        tail = XF if i < n - 1 else 0.0
        img = os.path.join(d, f"i{i:06d}")
        clip = os.path.join(d, f"c{i:06d}.mp4")
        fetch(p["url"], img)
        run(["ffmpeg", "-y", "-loop", "1", "-i", img, "-t", f"{dur + tail:.3f}",
             "-vf", clip_filter(i, dur + tail, p.get("prompt")),
             "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", clip])
        os.remove(img)
        done[0] += 1
        set_job(jid, pct=round(done[0] / n * 78),
                note=f"Rendering panels on GPU · {done[0]}/{n}")
        return dur

    with ThreadPoolExecutor(max_workers=LANES) as ex:
        durs = list(ex.map(one, range(n)))

    # ---- cross-fade inside groups, then stream-copy concat the groups ------
    groups = []
    gi = 0
    for g0 in range(0, n, GROUP):
        idxs = list(range(g0, min(n, g0 + GROUP)))
        gpath = os.path.join(d, f"g{gi:05d}.mp4")
        if len(idxs) == 1:
            shutil.copy(os.path.join(d, f"c{idxs[0]:06d}.mp4"), gpath)
        else:
            args, fc, prev = [], [], "0:v"
            for i in idxs:
                args += ["-i", os.path.join(d, f"c{i:06d}.mp4")]
            # clip k starts at the sum of the *visible* durations before it,
            # and its cross-fade with the previous clip begins exactly there
            off = 0.0
            for k in range(1, len(idxs)):
                off += max(0.8, durs[idxs[k - 1]])
                lab = f"x{k}"
                fc.append(f"[{prev}][{k}:v]xfade=transition=fade:duration={XF}:"
                          f"offset={max(0.05, off):.3f}[{lab}]")
                prev = lab

            span = sum(max(0.8, durs[i]) for i in idxs)
            run(["ffmpeg", "-y", *args, "-filter_complex", ";".join(fc),
                 "-map", f"[{prev}]", "-t", f"{span:.3f}",
                 "-r", str(FPS), *VCODEC, "-pix_fmt", "yuv420p", gpath])

        groups.append(gpath)
        gi += 1
        set_job(jid, pct=78 + round(gi / max(1, math.ceil(n / GROUP)) * 18),
                note=f"Stitching · part {gi}/{math.ceil(n / GROUP)}")

    listf = os.path.join(d, "list.txt")
    with open(listf, "w") as f:
        for g in groups:
            f.write(f"file '{g}'\n")
    final = os.path.join(OUT, f"{jid}.mp4")
    set_job(jid, pct=97, note="Writing final mp4…")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listf,
         "-c", "copy", "-movflags", "+faststart", final])
    shutil.rmtree(d, ignore_errors=True)
    size = os.path.getsize(final)
    set_job(jid, pct=100, state="done", note="Video ready", size=size,
            download=f"/download/{jid}.mp4")


def worker(jid, panels):
    try:
        render(jid, panels)
    except Exception as e:
        set_job(jid, state="error", note=str(e)[:500])


# ---------------------------------------------------------------- server ---

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj, extra=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        for k, v in {**CORS, **(extra or {})}.items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._send(200, {"ok": True, "gpu": NVENC, "lanes": LANES})
        m = re.match(r"^/status/([\w-]+)$", path)
        if m:
            j = JOBS.get(m.group(1))
            return self._send(200, j) if j else self._send(404, {"error": "no job"})
        m = re.match(r"^/download/([\w-]+)\.mp4$", path)
        if m:
            f = os.path.join(OUT, f"{m.group(1)}.mp4")
            if not os.path.exists(f):
                return self._send(404, {"error": "not ready"})
            size = os.path.getsize(f)
            self.send_response(200)
            for k, v in CORS.items():
                self.send_header(k, v)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             f'attachment; filename="manga-video.mp4"')
            self.end_headers()
            with open(f, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1024 * 1024)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/render":
            return self._send(404, {"error": "not found"})
        if not self._auth():
            return self._send(401, {"error": "bad token"})
        n = int(self.headers.get("Content-Length", "0"))
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        panels = data.get("panels") or []
        if not panels:
            return self._send(400, {"error": "no panels"})
        jid = uuid.uuid4().hex[:12]
        with LOCK:
            JOBS[jid] = {"id": jid, "state": "running", "pct": 0,
                         "note": "Queued", "panels": len(panels)}
        threading.Thread(target=worker, args=(jid, panels), daemon=True).start()
        self._send(200, {"id": jid})


def serve(port=8000):
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
