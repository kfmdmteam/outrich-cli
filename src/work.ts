// What a worker does with one block. Every function here is a pure function of (block, options):
// no state is carried from one record to the next, so the result does not depend on how many
// workers run or on where the block boundaries fall.
import { closeSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseCsv, toRows } from "./lib/profile.ts";
import { scanText, type Finding } from "./lib/secrets.ts";
import { createRecords, newTally, type Tally, type WorkerOptions } from "./records.ts";

export { addTally, newTally, type Tally } from "./records.ts";
export type Format = "text" | "jsonl" | "csv";
/** scrub rewrites; profile, plan and audit only read. */
export type RecordJob = { kind: "scrub" | "profile" | "plan" | "audit"; fmt: Format; bytes: Uint8Array; raw: boolean; endsLine: boolean; header?: string[]; delim?: string; first?: boolean; /** The file the block comes from. */ source?: string };
export type Job =
  | RecordJob
  | { kind: "secrets"; bytes: Uint8Array; path: string }
  | { kind: "keys"; bytes: Uint8Array; raw: boolean }
  | { kind: "convert"; to: Format; bytes: Uint8Array; raw: boolean; header: string[]; delim: string; first?: boolean }
  | { kind: "hash"; path: string; countLines: boolean };
export type Result = {
  out?: Uint8Array; tally?: Tally; findings?: Finding[]; lines?: number; keys?: string[]; invalid?: number; records?: number;
  size?: number; sha256?: string;
};

const decoder = new TextDecoder("utf-8", { ignoreBOM: true }); // invalid bytes become U+FFFD
const encoder = new TextEncoder();

export const csvCell = (v: string, d: string) => (v.includes(d) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLine = (cells: string[], d: string) => cells.map((v) => csvCell(v, d)).join(d) + "\n";

// Calls fn(line, eol) for each line of `text`. A trailing "\r" belongs to the line ending.
function eachLine(text: string, fn: (line: string, eol: string) => void) {
  for (let pos = 0; pos < text.length; ) {
    const nl = text.indexOf("\n", pos), end = nl === -1 ? text.length : nl;
    const cr = end > pos && text.charCodeAt(end - 1) === 13;
    fn(text.slice(pos, cr ? end - 1 : end), (cr ? "\r" : "") + (nl === -1 ? "" : "\n"));
    pos = end + 1;
  }
}

export function createWorker(options: WorkerOptions) {
  const rec = createRecords(options);

  function records(job: RecordJob): Result {
    const t = newTally(), write = job.kind === "scrub";
    rec.from(job.source ?? "");
    const text = decoder.decode(job.bytes);
    t.chars = text.length;
    const out: string[] = [];
    const look = (fmt: Format, item: string | string[]) => {
      const l = rec.read(fmt, item, job.header ?? [], t);
      if (l) (job.kind === "plan" ? rec.plan : job.kind === "audit" ? rec.audit : rec.profile)(l, t);
    };
    if (job.raw) {
      if (write) out.push(rec.text(text, t)); else look("text", text);
      if (job.endsLine) { t.records++; t.oversized++; }
    } else if (job.fmt === "csv") {
      const d = job.delim ?? ",", header = job.header ?? [];
      const rows = parseCsv(text, d);
      if (job.first) rows.shift();
      for (const row of rows) { t.records++; if (write) out.push(csvLine(rec.csvRow(row, header, t), d)); else look("csv", row); }
    } else {
      const json = job.fmt === "jsonl";
      eachLine(text, (line, eol) => {
        if (json ? line.trim() : line) {
          t.records++;
          if (write) out.push(json ? rec.jsonLine(line, t) : rec.text(line, t)); else look(job.fmt, line);
        } else if (write) out.push(line);
        if (write) out.push(eol);
      });
    }
    return write ? { out: encoder.encode(out.join("")), tally: t } : { tally: t };
  }

  function secrets(job: Extract<Job, { kind: "secrets" }>): Result {
    const text = decoder.decode(job.bytes);
    let lines = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
    return { findings: scanText(job.path, text), lines };
  }

  // Parses a JSONL block the way the website converter does (toRows), skipping lines that are not valid JSON.
  function jsonRows(text: string, raw: boolean) {
    if (raw) return { rows: [], invalid: 1 };
    try { return { rows: toRows("x.jsonl", text), invalid: 0 }; } catch { /* fall through: find the bad lines */ }
    const rows: Record<string, string>[] = [];
    let invalid = 0;
    eachLine(text, (line) => { if (line.trim()) try { rows.push(...toRows("x.jsonl", line)); } catch { invalid++; } });
    return { rows, invalid };
  }

  function keys(job: Extract<Job, { kind: "keys" }>): Result {
    const { rows } = jsonRows(decoder.decode(job.bytes), job.raw);
    return { keys: [...new Set(rows.flatMap((r) => Object.keys(r)))] };
  }

  function convert(job: Extract<Job, { kind: "convert" }>): Result {
    const text = decoder.decode(job.bytes), d = job.delim, head = job.header;
    const out: string[] = [];
    let invalid = 0, records = 0;
    if (job.to === "csv") {
      const r = jsonRows(text, job.raw);
      invalid = r.invalid; records = r.rows.length;
      for (const row of r.rows) out.push(csvLine(head.map((h) => row[h] ?? ""), d));
    } else if (job.raw) invalid = 1;
    else {
      const rows = parseCsv(text, d);
      if (job.first) rows.shift();
      records = rows.length;
      for (const r of rows) out.push(JSON.stringify(Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))) + "\n");
    }
    return { out: encoder.encode(out.join("")), invalid, records };
  }

  /** Streams a file through SHA-256 in 4 MB reads. Counts lines the way the website manifest does. */
  function hash(job: Extract<Job, { kind: "hash" }>, progress: (bytes: number) => void): Result {
    const h = createHash("sha256"), buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    const fd = openSync(job.path, "r");
    let size = 0, newlines = 0, lastByte = 10;
    try {
      for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) {
        const part = n === buf.length ? buf : buf.subarray(0, n);
        h.update(part);
        if (job.countLines) {
          for (let i = part.indexOf(10); i !== -1; i = part.indexOf(10, i + 1)) newlines++;
          lastByte = part[n - 1];
        }
        size += n;
        progress(n);
      }
    } finally { closeSync(fd); }
    return { size, sha256: h.digest("hex"), ...(job.countLines ? { lines: newlines + (lastByte === 10 ? 0 : 1) } : {}) };
  }

  return (job: Job, progress: (bytes: number) => void = () => {}): Result => {
    switch (job.kind) {
      case "scrub": case "profile": case "plan": case "audit": return records(job);
      case "secrets": return secrets(job);
      case "keys": return keys(job);
      case "convert": return convert(job);
      case "hash": return hash(job, progress);
    }
  };
}

