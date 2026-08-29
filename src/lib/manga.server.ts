import type { Segment } from "./script";
import { paralonKeys, pixazoKeys, pickKey } from "./keys.server";

const CHAT_URL = "https://paraloncloud.com/v1/chat/completions";
const CHAT_MODEL = "qwen3.8-27b";
const PIXAZO_URL = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData";

export const STYLE =
  "vibrant full-color anime manga illustration, rich saturated colour palette, cel shading with soft gradients, expressive cinematic lighting and colour, bold clean ink lines, detailed painted backgrounds, high quality anime key visual";

/**
 * Hard guards that stop the model from drawing a character reference sheet,
 * a character portrait inset, or a split/collage layout next to the scene.
 */
export const SINGLE_PANEL_GUARD =
  "ONE single full-bleed illustration of this one moment only, one continuous scene, " +
  "no character reference sheet, no character lineup, no turnaround, no inset portrait, " +
  "no side panel, no split screen, no collage, no grid, no multiple panels, no borders, " +
  "no duplicated characters, no repeated figures, no extra copies of the same person, " +
  "ONLY the people explicitly named in this description, no extra people, no bystanders, no crowd, no background characters, " +
  "no animals of any kind, no cow, no cattle, no sheep, no goat, no horse, no dog, no cat, no birds, no butterflies, no livestock, no wildlife, " +
  "no invented props or creatures that are not described, " +
  "every named character must keep the exact gender stated in this prompt, no gender swapping, no feminized male characters, no masculinized female characters, " +
  "no text, no captions, no speech bubbles, no watermark, no logo, NOT black and white, no monochrome, no greyscale, no sepia, no screentone dots, no manga halftone, full colour";

export async function zaiChat(
  messages: { role: string; content: string }[],
  opts: {
    temperature?: number;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    attempts?: number;
    /** Scene/batch index — spreads concurrent calls over the key pool. */
    slot?: number;
  } = {},
): Promise<string> {
  const keys = paralonKeys();
  const slot = opts.slot ?? 0;

  const attempts = opts.attempts ?? 3;
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 150_000),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model ?? CHAT_MODEL,
          temperature: opts.temperature ?? 0.6,
          // Disable Qwen3 thinking/reasoning mode so the model answers directly
          // and returns much faster. vLLM reads it from chat_template_kwargs;
          // the flat flag is kept for gateways that look at the top level.
          enable_thinking: false,
          chat_template_kwargs: { enable_thinking: false },
          max_tokens: opts.maxTokens ?? 4000,
          messages,
        }),
      });
      if (!res.ok) {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
        if (res.status === 400 || res.status === 401 || res.status === 403) break;
      } else {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning?: string } }[];
        };
        const msg = json.choices?.[0]?.message;
        const text = msg?.content?.trim() || extractFromReasoning(msg?.reasoning);
        if (text) return text;
        lastErr = "empty completion";
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    // 502/504 come from the provider's edge (HTML body), not the model:
    // back off progressively instead of failing the whole batch.
    if (attempt < attempts - 1)
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw new Error(`Text model request failed: ${lastErr}`);
}

/** Last-resort salvage: pull a JSON array out of truncated reasoning text. */
function extractFromReasoning(reasoning?: string): string | null {
  if (!reasoning) return null;
  const start = reasoning.indexOf("[");
  const end = reasoning.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  const slice = reasoning.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return Array.isArray(parsed) ? slice : null;
  } catch {
    return null;
  }
}


function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

export function parseJsonArray(raw: string): unknown[] {
  const text = stripFences(raw);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("Model did not return a JSON array");
  return JSON.parse(text.slice(start, end + 1)) as unknown[];
}

/** Builds a compact, reusable character bible from the whole script. */
export async function buildCharacterBible(script: string): Promise<string> {
  const sample =
    script.length > 24000
      ? script.slice(0, 12000) + "\n...\n" + script.slice(-12000)
      : script;

  const out = await zaiChat(
    [
      {
        role: "system",
        content:
          "You are a manga art director. Read the script (it may be Hinglish/Hindi) and list the recurring characters. " +
          "For each, give ONE compact English line of fixed visual traits usable inside an image prompt: " +
          "age, gender, hair, eyes, face, build, signature clothing. Max 6 characters. " +
          "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
          "Output plain lines like: Henan: male, 17-year-old Indian boy, messy black hair, sharp dark eyes, thin build, faded grey school shirt. " +
          "No headings, no numbering, no extra commentary. Do not deliberate — answer immediately.",
      },
      { role: "user", content: sample },
    ],
    { maxTokens: 2500, timeoutMs: 120_000 },
  );
  return stripFences(out).slice(0, 2000);
}


/** Writes one image prompt per segment, in batches. */
export async function writePrompts(
  bible: string,
  segments: Segment[],
  slot = 0,
): Promise<string[]> {
  const numbered = segments
    .map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`)
    .join("\n");

  let raw = "";
  try {
    raw = await zaiChat(
    [
      {
        role: "system",
        content:
          "You write image prompts for a manga storyboard. Input: a character bible and numbered script lines " +
          "(Hindi/Hinglish). For EACH numbered line write ONE English image prompt describing a SINGLE cinematic " +
          "moment from that line: who is in frame, their action and expression, the setting, the camera angle, and the LIGHTING + COLOUR palette (e.g. 'warm golden sunset light, amber and teal palette'). Each prompt is ONE meaningful visual beat: one shot, one moment.\n" +
          "RULES:\n" +
           "- Weave a character's fixed traits INLINE into the sentence (e.g. 'Henan, a thin 17-year-old boy with messy black hair, sits...'). " +
           "NEVER write a separate character description block, character sheet, reference, lineup, or 'plus portrait of'.\n" +
           "- GENDER ACCURACY (critical): every main character from the bible MUST be written with their name AND their exact gender from the bible, using an explicit gendered noun — e.g. 'Henan, a male 17-year-old boy...' or 'Priya, a female 14-year-old girl...'. Never refer to a main character as just 'a man', 'a woman', 'a person', 'he' or 'she' without the name. NEVER change, swap or reverse any character's gender — if the bible says male, the prompt must say male/man/boy; if female, female/woman/girl. For side characters not in the bible, pick one gender from the script context and state it explicitly (e.g. 'a female boss in her 40s, business suit').\n" +
           "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets, collages or side-by-side views.\n" +
           "- CAST FIDELITY: include ONLY the people that specific script line mentions. If a line mentions only Henan, the prompt must contain Henan ALONE — do not add his sister or anyone else. Never assume two characters are together unless the line says so.\n" +
           "- SIDE CHARACTERS: if the line mentions someone NOT in the character bible (e.g. a boss, teacher, shopkeeper), invent a short distinct visual for them inline (age, gender, one clothing detail) so they look clearly different from the main characters. NEVER substitute a main character's name or traits for a side character.\n" +
           "- STRICT FIDELITY: describe ONLY what the script line actually says. Never invent people, animals (cows, sheep, goats, dogs, cats, birds), vehicles, crowds or objects that the line does not mention. If the line names no location, keep the background simple and neutral.\n" +
          "- Always full colour. Never describe the image as black and white, monochrome, greyscale or screentone.\n- No text, letters, captions or speech bubbles in the image.\n" +
          "- 35 to 60 words each. English only.\n" +
          "- Do not deliberate or explain. Output the JSON array immediately.\n" +
          'Return ONLY a JSON array of strings, one per numbered line, in order.',
      },
      {
        role: "user",
        content: `CHARACTER BIBLE:\n${bible}\n\nSCRIPT LINES:\n${numbered}\n\nReturn a JSON array with exactly ${segments.length} prompt strings.`,
      },
    ],
    {
      temperature: 0.7,
      maxTokens: 400 + segments.length * 250,
      // Small batches answer in a few seconds; a call that hangs longer is
      // stuck, so fail over to another key instead of blocking the wave.
      timeoutMs: 45_000,
      attempts: 3,
      slot,
    },

    );
  } catch (e) {
    // Provider edge 502/504 or timeout: keep the storyboard going with
    // per-segment fallback prompts instead of blanking the whole run.
    console.error("writePrompts fell back:", e instanceof Error ? e.message : e);
    raw = "";
  }



  let arr: unknown[] = [];
  try {
    arr = parseJsonArray(raw);
  } catch {
    arr = [];
  }

  return segments.map((s, i) => {
    const v = arr[i];
    const text = typeof v === "string" && v.trim().length > 10 ? v.trim() : null;
    return sanitizePrompt(text ?? fallbackPrompt(s));
  });
}

function fallbackPrompt(s: Segment): string {
  return `A single cinematic manga scene depicting: ${s.text}`;
}

/** Removes phrasing that makes the model draw an extra character sheet / portrait. */
export function sanitizePrompt(p: string): string {
  return p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(/\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi, "full colour")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 6);
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) =>
    new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt),
  );
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? { she: "he", her: "his", hers: "his", herself: "himself", woman: "man", girl: "boy", lady: "man", "young woman": "young man" }
        : { he: "she", his: "her", him: "her", himself: "herself", man: "woman", boy: "girl", gentleman: "woman", "young man": "young woman" };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Stamp the gender next to each name so the renderer cannot misread it.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male" : "female";
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\))`, "g"),
      `${e.name} (${noun})`,
    );
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  const matched = entries.filter((e) =>
    new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt),
  );
  // Only lock characters actually present in this scene — never inject
  // the whole cast into a prompt that doesn't mention them.
  if (matched.length === 0) return "";
  return (
    "Fixed character appearance and GENDER (must match exactly, never swap or change gender): " +
    matched
      .map((e) => {
        const g = genderOf(e.traits);
        const traits = e.traits.replace(/\.$/, "");
        return g ? `${e.name} is ${g.toUpperCase()} — ${traits}` : `${e.name} is ${traits}`;
      })
      .join("; ") +
    "."
  );
}

export function composeImagePrompt(prompt: string, bible?: string): string {
  const fixed = enforceGender(sanitizePrompt(prompt), bible);
  const lock = characterLock(fixed, bible);
  // The gender lock goes FIRST: the earliest tokens carry the most weight in
  // Flux, which is exactly where character identity has to be pinned.
  return `${lock ? lock + " " : ""}${STYLE}. ${fixed}. ${SINGLE_PANEL_GUARD}. 16:9 widescreen cinematic framing.`;
}

/** Calls Flux.1 Schnell (free tier) with automatic retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
): Promise<string> {
  const keys = pixazoKeys();

  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = pickKey(keys, slot, attempt);
    try {

      const res = await fetch(PIXAZO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": key,
        },
        body: JSON.stringify({
          prompt: composeImagePrompt(prompt, bible).slice(0, 1800),
          num_steps: 4,
          seed: seed + attempt,
          width: 1024,
          height: 576,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { output?: string };
        if (json.output) return json.output;
        lastErr = "no output url";
      } else {
        lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}
