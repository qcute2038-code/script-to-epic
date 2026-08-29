import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseScript } from "./script";
import { buildCharacterBible, writePrompts, generateImage } from "./manga.server";

export const analyzeScript = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ script: z.string().min(5) }).parse(d))
  .handler(async ({ data }) => {
    const segments = parseScript(data.script);
    if (segments.length === 0) {
      throw new Error("No (m:ss) timestamps found in the script.");
    }
    const bible = await buildCharacterBible(data.script);
    return { segments, bible };
  });

export const promptsForBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string(),
        // which API key slot this batch should use, so parallel batches
        // spread across the whole key pool
        slot: z.number().int().min(0).default(0),
        segments: z.array(
          z.object({
            index: z.number(),
            start: z.number(),
            end: z.number(),
            text: z.string(),
          }),
        ),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const prompts = await writePrompts(data.bible, data.segments, data.slot);
    return { prompts };
  });

export const renderImage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        prompt: z.string().min(5),
        seed: z.number().int(),
        // text-only character consistency sheet, injected into every render
        bible: z.string().optional(),
        slot: z.number().int().min(0).default(0),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const url = await generateImage(data.prompt, data.seed, data.slot, data.bible);
    return { url };
  });

/**
 * Renders several panels in one round trip.
 *
 * A 2-hour script is ~1500 panels. Asking the browser to hold ~100 separate
 * server-function requests open saturates its connection pool, so each request
 * instead fans a small group out server-side. Failures are reported per item so
 * one bad panel never fails the group.
 */
export const renderBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        bible: z.string().optional(),
        jobs: z
          .array(
            z.object({
              index: z.number().int(),
              prompt: z.string().min(5),
              seed: z.number().int(),
              slot: z.number().int().min(0).default(0),
            }),
          )
          .min(1)
          .max(8),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const results = await Promise.all(
      data.jobs.map(async (j) => {
        try {
          const url = await generateImage(j.prompt, j.seed, j.slot, data.bible);
          return { index: j.index, url, error: null as string | null };
        } catch (e) {
          return {
            index: j.index,
            url: null as string | null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    return { results };
  });
