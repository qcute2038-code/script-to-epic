export type Segment = {
  index: number;
  start: number;
  end: number;
  text: string;
};

const TS = /\((\d{1,2}):(\d{2})(?::(\d{2}))?\)/g;

function toSeconds(m: RegExpExecArray): number {
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}

/**
 * Parses a script of the form:
 *   (0:00)text... (0:05)
 *   more text (0:09)
 * Every timestamp marks a boundary; the text between two boundaries is one segment.
 */
export function parseScript(raw: string): Segment[] {
  const marks: { at: number; time: number; len: number }[] = [];
  TS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TS.exec(raw)) !== null) {
    marks.push({ at: m.index, time: toSeconds(m), len: m[0].length });
  }
  if (marks.length === 0) return [];

  const segments: Segment[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i]!;
    const b = marks[i + 1]!;
    const text = raw.slice(a.at + a.len, b.at).replace(/\s+/g, " ").trim();
    let end = b.time;
    if (end <= a.time) end = a.time + 4;
    if (!text) continue;
    segments.push({ index: segments.length, start: a.time, end, text });
  }

  // Trailing text after the last timestamp (script may end without a closing mark)
  const last = marks[marks.length - 1]!;
  const tail = raw.slice(last.at + last.len).replace(/\s+/g, " ").trim();
  if (tail) {
    const words = tail.split(" ").length;
    const dur = Math.max(4, Math.min(12, Math.round(words / 2.5)));
    segments.push({
      index: segments.length,
      start: last.time,
      end: last.time + dur,
      text: tail,
    });
  }
  return segments;
}

export function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
