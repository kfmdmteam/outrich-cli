// Dataset profiler: parses CSV / TSV / JSON / JSONL in the browser and reports what a data buyer
// asks first. Pure, tested by `npm test`.
import { scrub, approxTokens, type PiiType } from "./pii.ts";

export type Row = Record<string, string>;

/** RFC 4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const str = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Turns file text into records. Throws a readable message when the format is not recognized. */
export function toRows(name: string, text: string): Row[] {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "json" || ext === "jsonl" || ext === "ndjson") {
    const trimmed = text.trim();
    const items: unknown[] = trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    return items.map((o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, str(v)])) : { value: str(o) }));
  }
  const table = parseCsv(text, ext === "tsv" || (text.split("\n", 1)[0].split("\t").length > text.split("\n", 1)[0].split(",").length) ? "\t" : ",");
  if (table.length < 2) throw new Error("No rows found. The file needs a header row and at least one record.");
  const [head, ...body] = table;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h || `column_${i + 1}`, r[i] ?? ""])));
}

export type ColumnReport = { name: string; fill: number; distinct: number; pii: PiiType[]; sample: string };
export type Profile = {
  rows: number; columns: ColumnReport[]; duplicateRows: number; tokens: number;
  dateFrom?: string; dateTo?: string; checks: { ok: boolean; text: string }[];
};

const SAMPLE = 2000; // rows scanned for personal data per column
const DATE = /\b(19|20)\d{2}-\d{2}-\d{2}\b/;

export function profile(rows: Row[]): Profile {
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  let chars = 0, dateFrom: string | undefined, dateTo: string | undefined;
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const r of rows) {
    const key = names.map((n) => r[n] ?? "").join("\u0001");
    chars += key.length;
    if (seen.has(key)) duplicateRows++; else seen.add(key);
    const d = key.match(DATE)?.[0];
    if (d) { if (!dateFrom || d < dateFrom) dateFrom = d; if (!dateTo || d > dateTo) dateTo = d; }
  }
  const sample = rows.slice(0, SAMPLE);
  const columns = names.map((name): ColumnReport => {
    const values = rows.map((r) => r[name] ?? "");
    const filled = values.filter((v) => v.trim() !== "");
    const counts = scrub(sample.map((r) => r[name] ?? "").join("\n"), { numbered: false }).counts;
    // A type counts as present when it shows up in at least 2% of sampled rows (or 3 hits in small files).
    const floor = Math.max(1, Math.min(3, Math.ceil(sample.length * 0.02)));
    const pii = (Object.entries(counts) as [PiiType, number][]).filter(([, n]) => n >= floor).map(([t]) => t);
    return { name, fill: rows.length ? filled.length / rows.length : 0, distinct: new Set(filled).size, pii, sample: (filled[0] ?? "").slice(0, 80) };
  });

  const piiCols = columns.filter((c) => c.pii.length);
  const sparse = columns.filter((c) => c.fill < 0.5);
  const dupRate = rows.length ? duplicateRows / rows.length : 0;
  const checks = [
    { ok: rows.length >= 1000, text: rows.length >= 1000 ? `${rows.length.toLocaleString()} records: enough to sample from.` : `${rows.length.toLocaleString()} records: buyers usually want thousands or more. Send the full export, not a sample.` },
    { ok: !piiCols.length, text: piiCols.length ? `Personal data found in ${piiCols.length} column${piiCols.length > 1 ? "s" : ""}: ${piiCols.map((c) => c.name).join(", ")}. These must be removed or replaced before licensing.` : "No personal data patterns found in the sampled rows." },
    { ok: dupRate < 0.05, text: dupRate < 0.05 ? "Fewer than 5% duplicate records." : `${Math.round(dupRate * 100)}% of records are exact duplicates. De-duplicate before you count volume.` },
    { ok: !sparse.length, text: sparse.length ? `${sparse.length} column${sparse.length > 1 ? "s are" : " is"} more than half empty: ${sparse.map((c) => c.name).join(", ")}.` : "Every column is at least half filled." },
    { ok: !!dateFrom, text: dateFrom ? `Dates run from ${dateFrom} to ${dateTo}. History depth is a main price driver.` : "No ISO dates found. Buyers ask for the time span, so include a timestamp column." },
  ];
  return { rows: rows.length, columns, duplicateRows, tokens: approxTokens(chars), dateFrom, dateTo, checks };
}
