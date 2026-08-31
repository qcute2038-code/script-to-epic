import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Dispatches video rendering to the self-hosted ffmpeg worker.
 *
 * Nothing is encoded in the browser: the worker downloads the panels, applies
 * the Ken Burns moves / colour grades / cross-fades and serves the finished
 * MP4 from its own disk.
 */

function workerConfig() {
  const base = (process.env["RENDER_WORKER_URL"] ?? "").replace(/\/+$/, "");
  const token = process.env["RENDER_TOKEN"] ?? "";
  if (!base) {
    throw new Error(
      "Render worker is not configured yet. Add the RENDER_WORKER_URL secret pointing at your AWS worker.",
    );
  }
  return { base, token };
}

const shot = z.object({
  url: z.string().url(),
  start: z.number(),
  end: z.number(),
  prompt: z.string().optional(),
});

export const startRender = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        shots: z.array(shot).min(1),
        width: z.union([z.literal(1280), z.literal(1920)]).default(1920),
        crf: z.number().int().min(16).max(30).default(20),
        preset: z.string().default("veryfast"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { base, token } = workerConfig();
    const res = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-render-token": token },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Worker rejected the job (${res.status}): ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { id: string };
    return { id: body.id };
  });

export const renderStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().min(8) }).parse(d))
  .handler(async ({ data }) => {
    const { base, token } = workerConfig();
    const res = await fetch(`${base}/jobs/${data.id}`, {
      headers: { "x-render-token": token },
    });
    if (!res.ok) throw new Error(`Worker status failed (${res.status})`);
    const j = (await res.json()) as {
      status: "queued" | "running" | "done" | "error";
      progress: number;
      note: string;
      error: string | null;
      bytes: number | null;
      url: string | null;
    };
    return {
      status: j.status,
      progress: j.progress,
      note: j.note,
      error: j.error,
      bytes: j.bytes,
      downloadUrl: j.url ? `${base}${j.url}` : null,
    };
  });

export const renderWorkerHealth = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { base } = workerConfig();
    const res = await fetch(`${base}/health`);
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
});
