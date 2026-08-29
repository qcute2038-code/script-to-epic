import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeScript, promptsForBatch, renderImage } from "@/lib/manga.functions";
import { fmt, type Segment } from "@/lib/script";
import { buildVideo, webCodecsSupported } from "@/lib/video";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Script to Manga — AI Manga Video Generator" },
      {
        name: "description",
        content:
          "Turn a long timestamped script into thousands of consistent 16:9 manga panels and export a full-length video.",
      },
      { property: "og:title", content: "Script to Manga — AI Manga Video Generator" },
      {
        property: "og:description",
        content:
          "Paste a 100k-character script, get one manga panel per timestamp and a downloadable hours-long video.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Shot = Segment & {
  prompt?: string | undefined;
  url?: string | undefined;
  status: "waiting" | "prompting" | "drawing" | "done" | "error";
  error?: string | undefined;
};

const SAMPLE = `(0:00)Henan की कहानी असुरा का उदय. Henan नाम का एक साधारण लड़का था. (0:05)

वह Mumbai के एक पुराने building की छोटी सी किराए की कोठरी में रहता था. (0:09)

कमरा इतना छोटा था कि एक बिस्तर, एक छोटी अलमारी और एक खिड़की के अलावा कुछ जगह ही नहीं बचती थी. (0:16)`;

/* ------------------------------------------------------------------ */
/* Pipeline tuning                                                     */
/* ------------------------------------------------------------------ */

/** Scenes per chat call — small batches answer in seconds. */
const BATCH = 6;
/** Parallel chat calls (≈3 per Paralon key). */
const PROMPT_CONCURRENCY = 12;
/** Parallel image renders (≈4 per Pixazo key). Auto-throttles on rate limits. */
const IMAGE_CONCURRENCY = 16;
/** Panels shown in the preview grid before "show all" (a 2h script has 1000+). */
const PREVIEW_LIMIT = 60;

/* ------------------------------------------------------------------ */
/* Crash-safe progress                                                 */
/* ------------------------------------------------------------------ */

function scriptKey(script: string): string {
  let h = 0;
  for (let i = 0; i < script.length; i++) h = (Math.imul(31, h) + script.charCodeAt(i)) | 0;
  return `manga:${script.length}:${h}`;
}

type Saved = { bible: string; shots: Shot[] };

function loadSaved(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function saveProgress(key: string, data: Saved) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota — progress just isn't resumable */
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
}

function Index() {
  const analyze = useServerFn(analyzeScript);
  const getPrompts = useServerFn(promptsForBatch);
  const draw = useServerFn(renderImage);

  const [script, setScript] = useState("");
  const [bible, setBible] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "video" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [videoPct, setVideoPct] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [canResume, setCanResume] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<Shot[]>([]);
  const cancelRef = useRef(false);

  shotsRef.current = shots;

  const doneCount = shots.filter((s) => s.status === "done").length;
  const failed = useMemo(() => shots.filter((s) => s.status === "error"), [shots]);
  const pct = shots.length ? Math.round((doneCount / shots.length) * 100) : 0;

  const stats = useMemo(() => {
    const words = script.trim() ? script.trim().split(/\s+/).length : 0;
    return { chars: script.length, words };
  }, [script]);

  const runtime = useMemo(() => {
    if (shots.length === 0) return 0;
    return shots.reduce((a, s) => a + Math.max(0.8, s.end - s.start), 0);
  }, [shots]);

  // offer to resume whatever this exact script produced last time
  useEffect(() => {
    if (script.trim().length < 10) {
      setCanResume(false);
      return;
    }
    const saved = loadSaved(scriptKey(script));
    setCanResume(!!saved && saved.shots.length > 0 && shots.length === 0);
  }, [script, shots.length]);

  const patch = useCallback((index: number, next: Partial<Shot>) => {
    setShots((prev) => prev.map((s) => (s.index === index ? { ...s, ...next } : s)));
  }, []);

  function resume() {
    const saved = loadSaved(scriptKey(script));
    if (!saved) return;
    setBible(saved.bible);
    setShots(saved.shots);
    setPhase("done");
    setNote(
      `Restored ${saved.shots.filter((s) => s.status === "done").length}/${saved.shots.length} panels from your last run.`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  async function run(existing?: Shot[], existingBible?: string) {
    setError(null);
    setVideoUrl(null);
    setSavedTo(null);
    cancelRef.current = false;
    setPhase("running");
    const key = scriptKey(script);

    try {
      let b = existingBible ?? "";
      let list: Shot[];

      if (existing && existing.length > 0) {
        list = existing;
      } else {
        setNote("Reading script and locking character designs…");
        const res = await analyze({ data: { script } });
        b = res.bible;
        list = res.segments.map((s) => ({ ...s, status: "waiting" as const }));
      }
      setBible(b);
      setShots(list);

      const pending = list.filter((s) => s.status !== "done" || !s.url);
      const total = list.length;

      // Stage 1: prompts for everything still missing one, in small parallel
      // batches. Stage 2 drains a shared queue as soon as prompts land, so
      // image rendering starts within seconds instead of after the last batch.
      const needPrompts = pending.filter((s) => !s.prompt);
      const batches: Segment[][] = [];
      for (let i = 0; i < needPrompts.length; i += BATCH)
        batches.push(needPrompts.slice(i, i + BATCH));

      let promptDone = total - needPrompts.length;
      let drawn = list.filter((s) => s.status === "done").length;
      let lastTick = 0;
      const tick = (force = false) => {
        const now = Date.now();
        if (!force && now - lastTick < 300) return;
        lastTick = now;
        setNote(`Prompts ${promptDone}/${total} · panels ${drawn}/${total}`);
      };
      tick(true);

      let keyTick = 0;
      const queue: { seg: Shot; prompt: string }[] = pending
        .filter((s) => s.prompt && !s.url)
        .map((s) => ({ seg: s, prompt: s.prompt as string }));

      let promptingDone = batches.length === 0;

      const record = (index: number, next: Partial<Shot>) => {
        list = list.map((x) => (x.index === index ? { ...x, ...next } : x));
        patch(index, next);
      };

      let saveTimer = 0;
      const persist = () => {
        const now = Date.now();
        if (now - saveTimer < 4000) return;
        saveTimer = now;
        saveProgress(key, { bible: b, shots: list });
      };

      const promptStage = pool(batches, PROMPT_CONCURRENCY, async (batch) => {
        if (cancelRef.current) return;
        try {
          const res = await getPrompts({
            data: {
              bible: b,
              segments: batch.map((s) => ({
                index: s.index,
                start: s.start,
                end: s.end,
                text: s.text,
              })),
              slot: keyTick++,
            },
          });
          const prompts = res.prompts as string[];
          batch.forEach((s, i) => {
            const prompt = prompts[i];
            if (!prompt) {
              record(s.index, { status: "error", error: "no prompt" });
              return;
            }
            record(s.index, { prompt, status: "waiting" });
            queue.push({ seg: s as Shot, prompt });
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          batch.forEach((s) => record(s.index, { status: "error", error: msg }));
        }
        promptDone += batch.length;
        tick();
      }).then(() => {
        promptingDone = true;
      });

      // Adaptive throttle: back off globally when the provider rate-limits.
      let cooldownUntil = 0;

      const worker = async () => {
        for (;;) {
          if (cancelRef.current) return;
          const job = queue.shift();
          if (!job) {
            if (promptingDone) return;
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          const wait = cooldownUntil - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));

          const { seg: s, prompt } = job;
          record(s.index, { status: "drawing" });
          try {
            const { url } = await draw({
              data: { prompt, seed: 1000 + s.index, slot: keyTick++, bible: b },
            });
            record(s.index, { url, status: "done", error: undefined });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/429|rate|quota/i.test(msg)) cooldownUntil = Date.now() + 5000;
            record(s.index, { status: "error", prompt, error: msg });
          }
          drawn++;
          tick();
          persist();
        }
      };

      await Promise.all([
        promptStage,
        ...Array.from({ length: IMAGE_CONCURRENCY }, () => worker()),
      ]);

      saveProgress(key, { bible: b, shots: list });
      setPhase("done");
      const bad = list.filter((s) => !s.url).length;
      setNote(bad ? `${list.length - bad}/${list.length} panels ready · ${bad} failed` : "All panels generated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function retryFailed() {
    setPhase("running");
    const key = scriptKey(script);
    let keyTick = 0;
    let list = shotsRef.current;
    const record = (index: number, next: Partial<Shot>) => {
      list = list.map((x) => (x.index === index ? { ...x, ...next } : x));
      patch(index, next);
    };
    const targets = shotsRef.current.filter((s) => !s.url);
    let n = 0;
    await pool(targets, IMAGE_CONCURRENCY, async (shot) => {
      record(shot.index, { status: "drawing" });
      try {
        let prompt = shot.prompt;
        if (!prompt) {
          const { prompts } = await getPrompts({
            data: {
              bible,
              segments: [{ index: shot.index, start: shot.start, end: shot.end, text: shot.text }],
              slot: keyTick++,
            },
          });
          prompt = prompts[0] as string;
        }
        const { url } = await draw({
          data: { prompt, seed: 7000 + shot.index, slot: keyTick++, bible },
        });
        record(shot.index, { url, prompt, status: "done", error: undefined });
      } catch (e) {
        record(shot.index, { status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      n++;
      setNote(`Retrying failed panels ${n}/${targets.length}`);
    });
    saveProgress(key, { bible, shots: list });
    setPhase("done");
    setNote("Retry finished.");
  }

  /* ---------------------------------------------------------------- */
  /* Video                                                             */
  /* ---------------------------------------------------------------- */

  async function makeVideo() {
    setError(null);
    setSavedTo(null);
    setVideoUrl(null);

    const ready = shotsRef.current
      .filter((s) => s.url)
      .sort((a, b) => a.start - b.start)
      .map((s) => ({ url: s.url as string, start: s.start, end: s.end, prompt: s.prompt }));

    if (ready.length === 0) {
      setError("No finished panels to build a video from.");
      return;
    }
    if (!webCodecsSupported()) {
      setError(
        "Your browser has no hardware video encoder. Open this page in the latest desktop Chrome, Edge or Opera.",
      );
      return;
    }

    const seconds = ready.reduce((a, s) => a + Math.max(0.8, s.end - s.start), 0);
    const long = seconds > 600; // 10 min+ must stream to disk, not to RAM

    // A 2-hour mp4 is multiple gigabytes: stream it straight into a file the
    // user picks so nothing has to be held in memory.
    let handle: FileSystemFileHandle | undefined;
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;

    if (picker) {
      try {
        handle = await picker({
          suggestedName: "manga-video.mp4",
          types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
        });
      } catch {
        if (long) {
          setError("A video this long must be saved to a file. Pick a save location and try again.");
          return;
        }
      }
    } else if (long) {
      setError(
        "This browser cannot stream a multi-hour video to disk. Use desktop Chrome or Edge so the file can be written directly.",
      );
      return;
    }

    setPhase("video");
    setVideoPct(0);
    try {
      const res = await buildVideo(
        ready,
        (p, n) => {
          setVideoPct(p);
          setNote(n);
        },
        { fileHandle: handle },
      );
      if (res.kind === "file") {
        setSavedTo(res.fileName);
        setNote(`Saved ${res.fileName}`);
      } else {
        setVideoUrl(URL.createObjectURL(res.blob));
      }
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then(setScript);
  }

  const busy = phase === "running" || phase === "video";
  const visible = showAll ? shots : shots.slice(0, PREVIEW_LIMIT);

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-4 border-foreground pb-6">
          <p className="text-xs font-bold uppercase tracking-[0.4em] text-accent-foreground">
            AI Manga Studio
          </p>
          <h1 className="mt-2 font-display text-5xl font-black uppercase leading-none tracking-tight">
            Script → Manga Video
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            Paste a timestamped script — including full-length ones of 100,000+ characters. Every{" "}
            <span className="font-semibold">(m:ss)</span> window becomes one fixed-style 16:9 manga
            panel with locked character identities, then everything is encoded into a single
            downloadable video.
          </p>
        </header>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="font-display text-lg font-bold uppercase">Your script</label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {stats.chars.toLocaleString()} chars · {stats.words.toLocaleString()} words
              </span>
              <button
                onClick={() => setScript(SAMPLE)}
                className="rounded-none border-2 border-foreground px-3 py-1 font-semibold uppercase hover:bg-foreground hover:text-background"
              >
                Sample
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-none border-2 border-foreground px-3 py-1 font-semibold uppercase hover:bg-foreground hover:text-background"
              >
                Upload .txt
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                onChange={onFile}
                className="hidden"
              />
            </div>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={12}
            spellCheck={false}
            placeholder="(0:00)पहली लाइन... (0:05)&#10;&#10;दूसरी लाइन... (0:09)"
            className="mt-3 w-full resize-y border-2 border-foreground bg-card p-4 font-mono text-sm outline-none focus:ring-4 focus:ring-ring"
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              disabled={busy || script.trim().length < 10}
              onClick={() => run()}
              className="border-4 border-foreground bg-primary px-6 py-3 font-display text-lg font-black uppercase text-primary-foreground shadow-[6px_6px_0_0_var(--color-foreground)] transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[3px_3px_0_0_var(--color-foreground)] disabled:opacity-40"
            >
              {busy ? "Working…" : "Generate manga"}
            </button>
            {canResume && !busy && (
              <button
                onClick={resume}
                className="border-4 border-foreground bg-secondary px-6 py-3 font-display text-lg font-black uppercase text-secondary-foreground"
              >
                Resume last run
              </button>
            )}
            {failed.length > 0 && !busy && (
              <button
                onClick={retryFailed}
                className="border-4 border-foreground bg-destructive px-6 py-3 font-display text-lg font-black uppercase text-destructive-foreground"
              >
                Retry {failed.length} failed
              </button>
            )}
            {doneCount > 0 && !busy && (
              <button
                onClick={makeVideo}
                className="border-4 border-foreground bg-accent px-6 py-3 font-display text-lg font-black uppercase text-accent-foreground"
              >
                Build video
              </button>
            )}
            {busy && (
              <button
                onClick={() => {
                  cancelRef.current = true;
                }}
                className="border-4 border-foreground px-6 py-3 font-display text-lg font-black uppercase"
              >
                Stop
              </button>
            )}
          </div>
        </section>

        {(shots.length > 0 || busy) && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <div className="flex items-center justify-between gap-4 font-mono text-xs uppercase">
              <span className="truncate">{note || "Ready"}</span>
              <span className="shrink-0">
                {doneCount}/{shots.length} panels ·{" "}
                {runtime ? `${Math.floor(runtime / 60)}m runtime` : "—"}
              </span>
            </div>
            <div className="mt-3 h-4 w-full border-2 border-foreground">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${phase === "video" ? videoPct : pct}%` }}
              />
            </div>
            {bible && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-display font-bold uppercase">
                  Character consistency sheet (text only — never drawn)
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                  {bible}
                </pre>
              </details>
            )}
          </section>
        )}

        {error && (
          <p className="mt-4 border-2 border-destructive bg-destructive/10 p-3 text-sm">{error}</p>
        )}

        {savedTo && (
          <p className="mt-4 border-2 border-foreground bg-card p-3 text-sm">
            Video written to <span className="font-mono font-bold">{savedTo}</span>.
          </p>
        )}

        {videoUrl && (
          <section className="mt-8 border-4 border-foreground bg-card p-5">
            <h2 className="font-display text-2xl font-black uppercase">Your video</h2>
            <video src={videoUrl} controls className="mt-3 w-full border-2 border-foreground" />
            <a
              href={videoUrl}
              download="manga-video.mp4"
              className="mt-3 inline-block border-4 border-foreground bg-primary px-5 py-2 font-display font-black uppercase text-primary-foreground"
            >
              Download mp4
            </a>
          </section>
        )}

        {shots.length > 0 && (
          <>
            <section className="mt-8 grid gap-5 sm:grid-cols-2">
              {visible.map((s) => (
                <article key={s.index} className="border-4 border-foreground bg-card">
                  <div className="flex items-center justify-between border-b-2 border-foreground px-3 py-2 font-mono text-xs uppercase">
                    <span>
                      #{s.index + 1} · {fmt(s.start)} → {fmt(s.end)}
                    </span>
                    <span
                      className={s.status === "error" ? "text-destructive" : "text-muted-foreground"}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="aspect-video w-full bg-muted">
                    {s.url ? (
                      <img
                        src={s.url}
                        alt={`Manga panel ${s.index + 1}`}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center font-mono text-xs text-muted-foreground">
                        {s.status === "error" ? "failed" : "…"}
                      </div>
                    )}
                  </div>
                  <p className="border-t-2 border-foreground p-3 text-xs text-muted-foreground">
                    {s.text}
                  </p>
                </article>
              ))}
            </section>
            {shots.length > PREVIEW_LIMIT && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="mt-6 border-2 border-foreground px-4 py-2 font-display text-sm font-bold uppercase"
              >
                {showAll
                  ? "Show first 60 panels"
                  : `Show all ${shots.length.toLocaleString()} panels`}
              </button>
            )}
          </>
        )}
      </div>
    </main>
  );
}
