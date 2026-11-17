// Small, pure data utilities behind the free tools. Browser-only at runtime; tested by `npm test`.
import { toRows, type Row } from "./profile.ts";
import { approxTokens } from "./pii.ts";

export type Format = "csv" | "tsv" | "json" | "jsonl";

const cell = (v: string, d: string) => (v.includes(d) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toDelimited(rows: Row[], delimiter = ","): string {
  const head = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [head, ...rows.map((r) => head.map((h) => r[h] ?? ""))].map((line) => line.map((v) => cell(v, delimiter)).join(delimiter)).join("\n") + "\n";
}

export function serialize(rows: Row[], to: Format): string {
  if (to === "json") return JSON.stringify(rows, null, 2) + "\n";
  if (to === "jsonl") return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return toDelimited(rows, to === "tsv" ? "\t" : ",");
}

/** Converts between CSV, TSV, JSON and JSONL. The source format is taken from the file name. */
export const convert = (name: string, text: string, to: Format) => serialize(toRows(name, text), to);

/** Removes repeated lines, keeping the first of each. The first line is kept as a header when asked. */
export function dedupeLines(text: string, o: { ignoreCase?: boolean; trim?: boolean; header?: boolean } = {}) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const seen = new Set<string>();
  const out: string[] = [];
  lines.forEach((line, i) => {
    let key = o.trim ? line.trim().replace(/\s+/g, " ") : line;
    if (o.ignoreCase) key = key.toLowerCase();
    if ((o.header && i === 0) || !seen.has(key)) out.push(line);
    seen.add(key);
  });
  return { text: out.join("\n") + (out.length ? "\n" : ""), kept: out.length, removed: lines.length - out.length };
}

/** Checks that every line is a JSON object and reports which keys appear and how often. */
export function validateJsonl(text: string) {
  const errors: { line: number; message: string }[] = [];
  const keys: Record<string, number> = {};
  let records = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Line is valid JSON but not an object");
      records++;
      for (const k of Object.keys(v)) keys[k] = (keys[k] ?? 0) + 1;
    } catch (e) {
      if (errors.length < 200) errors.push({ line: i + 1, message: e instanceof Error ? e.message : "Invalid JSON" });
    }
  });
  return { records, errors, keys };
}

export function measure(text: string) {
  return {
    characters: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    lines: text ? text.split(/\r?\n/).length : 0,
    tokens: approxTokens(text.length),
  };
}

/** Drops some columns and replaces the values of others using `mask` (a hash in the browser). */
export async function transformColumns(rows: Row[], drop: string[], hash: string[], mask: (value: string) => Promise<string>): Promise<Row[]> {
  const cache = new Map<string, string>();
  const out: Row[] = [];
  for (const r of rows) {
    const next: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (drop.includes(k)) continue;
      if (hash.includes(k) && v !== "") {
        if (!cache.has(v)) cache.set(v, await mask(v));
        next[k] = cache.get(v)!;
      } else next[k] = v;
    }
    out.push(next);
  }
  return out;
}
