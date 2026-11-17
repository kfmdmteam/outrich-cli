// The local commands. Each one reads with backpressure, hands blocks to the worker pool, and takes
// results back in order through a bounded window, so memory stays flat whatever the input size.
// Every command returns { code, data, text }: the caller prints one of them, and `run` chains them.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { blocks, csvScanner, lineScanner, MAX_LINE, type Block, type Scanner } from "./blocks.ts";
import { Pool } from "./pool.ts";
import { addTally, csvCell, newTally, type Format, type Job, type Result, type Tally } from "./work.ts";
import { GATED, type Residual, type WorkerOptions } from "./records.ts";
import { inside, openInput, openOutput, Progress, State, STATE_FILE, walk, writeAtomic, type Entry, type Skipped } from "./files.ts";
import { preOf, zipEntries, type Pre } from "./sources.ts";
import { keyRule, POLICY_VERSION, type Policy, type PolicyFile } from "./fields.ts";
import { approxTokens, ENGINE_VERSION, type PiiType } from "./lib/pii.ts";
import { buildManifest, describeFile, formatBytes, parseManifest, verifyManifest, type ManifestFile } from "./lib/manifest.ts";
import { parseCsv } from "./lib/profile.ts";
import { isBinary, skipReason } from "./lib/secrets.ts";

declare const __VERSION__: string;
export const VERSION = __VERSION__;

export type Common = { workers: number; resume: boolean; json: boolean; quiet: boolean; /** Set by scrub so that its residual check reuses the same worker threads. */ pool?: Pool };
export type Out = { code: number; data: Record<string, any>; text: string[] };
/** Thrown for mistakes in how the tool was called. Exit code 2, no stack trace. */
export class UsageError extends Error {}

type Task = Entry & { fmt: Format; gz: boolean; pre?: Pre };
type Ctx = { pool: Pool; window: number; progress: Progress };
type Failure = { path: string; error: string };

const TEXT_FILE = /\.(txt|log|md|jsonl|ndjson|csv|tsv|mbox|eml|json)(\.gz)?$/i;
const FORMATS = ".txt .log .md .jsonl .ndjson .csv .tsv .json .mbox .eml, optionally .gz";
const isGz = (name: string) => /\.gz$/i.test(name);
const isZip = (name: string) => /\.zip$/i.test(name);
const formatOf = (name: string): Format => { const n = name.replace(/\.gz$/i, ""); return /\.(jsonl|ndjson)$/i.test(n) ? "jsonl" : /\.(csv|tsv)$/i.test(n) ? "csv" : "text"; };
const taskOf = (e: Entry): Task => { const pre = preOf(e.rel); return { ...e, fmt: pre ? "jsonl" : formatOf(e.rel), gz: isGz(e.rel), pre }; };
/** Mail and JSON documents come out as JSON Lines, so their output name says so. */
const outName = (t: Task) => (t.pre ? t.rel.replace(/\.gz$/i, "") + ".jsonl" : t.rel);
export const num = (n: number) => n.toLocaleString("en-US");
const say = (c: Common, text: string) => { if (!c.quiet) process.stderr.write(text + "\n"); };
const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** The files to work on: every file under a folder, every entry of a .zip, or the one file named. `root` is null for a single file. */
function inputs(input: string, exclude?: (abs: string) => boolean): { root: string | null; files: Entry[]; skipped: Skipped[] } {
  let st: fs.Stats;
  try { st = fs.statSync(input); } catch { throw new UsageError(`Cannot find ${input}.`); }
  if (st.isDirectory()) return { root: path.resolve(input), ...walk(path.resolve(input), exclude) };
  if (!st.isFile()) throw new UsageError(`${input} is not a file or a folder.`);
  const abs = path.resolve(input);
  if (!isZip(input)) return { root: null, files: [{ rel: path.basename(input), abs, size: st.size, mtimeMs: st.mtimeMs }], skipped: [] };
  const files: Entry[] = [], skipped: Skipped[] = [];
  for (const e of zipEntries(abs)) {
    const rel = e.name.replace(/\\/g, "/");
    if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split("/").includes("..")) skipped.push({ path: rel, reason: "zip entry with an unsafe path" });
    else files.push({ rel, abs, size: e.size, mtimeMs: st.mtimeMs, zip: e.ref });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { root: abs, files, skipped };
}

async function withPool<T>(c: Common, options: WorkerOptions, label: string, files: Entry[], passes: number, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const pool = c.pool ?? new Pool(c.workers, options);
  const progress = new Progress(label, passes * files.reduce((n, f) => n + (f.zip ? f.zip.csize : f.size), 0), !c.quiet);
  pool.onProgress = progress.add;
  // In-flight blocks per file. Many files share the workers, so each gets a smaller window.
  const window = Math.max(2, Math.ceil((2 * c.workers) / Math.max(1, Math.min(c.workers, files.length))));
  try { return await fn({ pool, window, progress }); } finally { progress.stop(); if (!c.pool) await pool.close(); }
}

/** Reads `task` block by block, runs a job per block and delivers the results in input order. `job` returns null to stop early. */
async function stream(ctx: Ctx, task: Task, scanner: Scanner, job: (b: Block, index: number) => Job | null, onResult: (r: Result) => void | Promise<void>) {
  const pending: Promise<Result>[] = [];
  const flush = async () => onResult(await pending.shift()!);
  let i = 0;
  for await (const b of blocks(openInput(task, ctx.progress.add), scanner)) {
    const j = job(b, i++);
    if (!j) break;
    const p = ctx.pool.run(j);
    p.catch(() => {}); // reported when it is flushed
    pending.push(p);
    if (pending.length >= ctx.window) await flush();
  }
  while (pending.length) await flush();
}

/** Delimiter and header row of a CSV or TSV file. */
async function csvInfo(task: Task): Promise<{ delim: string; header: string[]; names: string[] }> {
  let head: Buffer = Buffer.alloc(0);
  for await (const c of openInput(task)) { head = Buffer.concat([head, c]); if (head.includes(10) || head.length >= MAX_LINE) break; }
  const line = head.subarray(0, head.includes(10) ? head.indexOf(10) : head.length).toString("utf8");
  const delim = /\.tsv(\.gz)?$/i.test(task.rel) || line.split("\t").length > line.split(",").length ? "\t" : ",";
  for await (const b of blocks(openInput(task), csvScanner(delim.charCodeAt(0)))) {
    if (b.raw) throw new Error("The header row is longer than 4 MiB. Is this a CSV file?");
    const header = parseCsv(new TextDecoder().decode(b.bytes), delim)[0] ?? [];
    return { delim, header, names: header.map((h, i) => h || `column_${i + 1}`) };
  }
  return { delim, header: [], names: [] };
}
const csvLine = (cells: string[], d: string) => Buffer.from(cells.map((v) => csvCell(v, d)).join(d) + "\n");

/** Runs a read-only record job (profile, plan, audit) over one file and returns the merged tally. `maxBlocks` bounds a sample. */
async function readRecords(ctx: Ctx, task: Task, kind: "profile" | "plan" | "audit", maxBlocks = Infinity): Promise<Tally> {
  const t = newTally();
  let scanner = lineScanner(), header: string[] | undefined, delim: string | undefined;
  if (task.fmt === "csv") { const info = await csvInfo(task); header = info.names; delim = info.delim; scanner = csvScanner(delim.charCodeAt(0)); }
  await stream(ctx, task, scanner, (b, i) => (i >= maxBlocks ? null : { kind, fmt: task.fmt, ...b, header, delim, first: i === 0, source: task.rel }), (r) => { addTally(t, r.tally!); });
  return t;
}

/** The record files under `input`, plus what was left out and why. */
function recordTasks(input: string, exclude?: (abs: string) => boolean) {
  const { root, files, skipped } = inputs(input, exclude);
  const tasks = files.filter((e) => !root || TEXT_FILE.test(e.rel)).map(taskOf);
  if (root) for (const e of files) if (!TEXT_FILE.test(e.rel)) skipped.push({ path: e.rel, reason: `not a supported text format (${FORMATS})` });
  return { root, tasks, skipped };
}

/* ------------------------------------------------------------------ scrub */

export type ScrubFlags = { output?: string; report?: string; policy?: { rules: Policy; hash: string; file: string }; strict?: boolean; audit?: boolean; maxResidual?: number };
type FileReport = { path: string; size: number; mtimeMs: number; bytesIn: number; bytesOut: number } & Omit<Tally, "chars" | "fields" | "plan" | "residual">;

async function scrubFile(ctx: Ctx, task: Task, dest: string, f: ScrubFlags): Promise<FileReport> {
  const out = await openOutput(dest, isGz(dest));
  const t = newTally();
  try {
    let scanner = lineScanner(), header: string[] | undefined, delim: string | undefined;
    if (task.fmt === "csv") {
      const info = await csvInfo(task);
      header = info.names; delim = info.delim; scanner = csvScanner(delim.charCodeAt(0));
      const kept = info.header.filter((_, i) => f.policy?.rules[info.names[i]]?.action !== "drop");
      if (info.header.length) await out.write(csvLine(kept, delim));
    }
    await stream(ctx, task, scanner, (b, i) => ({ kind: "scrub", fmt: task.fmt, ...b, header, delim, first: i === 0, source: task.rel }), async (r) => {
      addTally(t, r.tally!);
      if (f.strict && t.unknown.length) throw new Error(`--strict: the data has field paths the policy does not list: ${t.unknown.slice(0, 8).join(", ")}`);
      await out.write(r.out!);
    });
    const { chars: _c, fields: _f, plan: _p, residual: _r, ...counts } = t;
    return { path: task.rel, size: task.size, mtimeMs: task.mtimeMs, bytesIn: task.zip ? task.zip.csize : task.size, bytesOut: await out.commit(), ...counts };
  } catch (e) { await out.abort(); throw e; }
}

/** One set of worker threads serves the scrub and the residual check after it. Starting a second set would raise peak memory. */
export async function scrub(c: Common, input: string, f: ScrubFlags, options: WorkerOptions): Promise<Out> {
  const pool = new Pool(c.workers, { ...options, policy: f.policy?.rules, strict: f.strict });
  try { return await scrubWith({ ...c, pool }, input, f, options); } finally { await pool.close(); }
}

async function scrubWith(c: Common, input: string, f: ScrubFlags, options: WorkerOptions): Promise<Out> {
  if (!f.output) throw new UsageError("scrub needs an output path: outrich scrub <file|dir|zip> -o <out>");
  const started = Date.now();
  let outPath = path.resolve(f.output);
  const dirMode = isDir(input) || isZip(input);
  if (dirMode) {
    const root = path.resolve(input);
    if (inside(outPath, root)) throw new UsageError("The output folder is the input folder or contains it. Choose an output folder elsewhere.");
    if (fs.existsSync(outPath) && !isDir(outPath)) throw new UsageError(`${f.output} exists and is not a folder.`);
    if (isDir(input) && inside(root, outPath)) say(c, `Note: the output folder is inside the input folder. It is left out of the scan.`);
  } else {
    if (isDir(outPath)) outPath = path.join(outPath, path.basename(input));
    if (fs.existsSync(input) && fs.existsSync(outPath) && fs.realpathSync(input) === fs.realpathSync(outPath)) throw new UsageError("The output file is the input file. Choose a different output path.");
  }
  const { files, skipped } = inputs(input, (abs) => inside(outPath, abs));
  const tasks = files.filter((e) => !dirMode || TEXT_FILE.test(e.rel)).map(taskOf);
  if (dirMode) for (const e of files) if (!TEXT_FILE.test(e.rel)) skipped.push({ path: e.rel, reason: `not a supported text format (${FORMATS}); not copied` });
  if (!dirMode && !TEXT_FILE.test(tasks[0].rel)) say(c, `Note: ${tasks[0].rel} has no known text extension. It is read as plain text, line by line.`);

  const shown = { mode: options.mode, numbered: options.numbered, nameSensitivity: options.nameSensitivity, types: options.types, salt: options.salt ? "set (value not recorded)" : "none", policy: f.policy ? { file: f.policy.file, sha256: f.policy.hash } : "none (field names decide)", strict: !!f.strict };
  const state = dirMode ? new State<FileReport>(path.join(outPath, STATE_FILE), JSON.stringify(["scrub", VERSION, path.resolve(input), shown, createHash("sha256").update(options.salt ?? "").digest("hex")]), c.resume) : null;
  if (c.resume && !dirMode) say(c, "Note: --resume applies to folder runs. A single file is processed from the start.");
  const done: FileReport[] = [], errors: Failure[] = [];
  let resumed = 0;
  await withPool(c, {}, "scrub", tasks, 1, (ctx) => eachLimit(tasks, c.workers, async (task) => {
    const dest = dirMode ? path.join(outPath, outName(task)) : outPath;
    const saved = state?.get(task);
    if (saved && fs.existsSync(dest)) { done.push(saved); resumed++; ctx.progress.add(task.size); return; }
    try {
      const r = await scrubFile(ctx, task, dest, f);
      done.push(r);
      state?.add(r);
    } catch (e) { errors.push({ path: task.rel, error: (e as Error).message }); }
  }));
  if (!errors.length) state?.finish();

  done.sort(byPath);
  const total = newTally();
  let bytesIn = 0, bytesOut = 0;
  for (const d of done) { addTally(total, { ...d, chars: 0, fields: {}, plan: {}, residual: {} }); bytesIn += d.bytesIn; bytesOut += d.bytesOut; }
  const data: Out["data"] = {
    tool: "outrich", version: VERSION, engine: ENGINE_VERSION, command: "scrub",
    started: new Date(started).toISOString(), finished: new Date().toISOString(), durationMs: Date.now() - started,
    options: { ...shown, workers: c.workers, resume: c.resume },
    input: path.resolve(input), output: outPath,
    totals: { files: done.length, filesResumed: resumed, bytesIn, bytesOut, records: total.records, replacements: total.replacements, jsonLinesScrubbedAsText: total.invalidJson, oversizedRecords: total.oversized },
    counts: total.counts, rules: total.rules, byField: total.byField,
    files: done.map(({ size: _s, mtimeMs: _m, byField: _b, unknown: _u, ...d }) => d),
    skipped, errors,
    note: "Counts only. The removed values are never written to this report. Detection is pattern and dictionary based: it reduces personal data but does not guarantee removal. Sample the output before you rely on it.",
  };
  const secs = (Date.now() - started) / 1000;
  const text = [
    `Scrubbed ${num(done.length)} file${done.length === 1 ? "" : "s"}, ${formatBytes(bytesIn)}, ${num(total.records)} records in ${secs.toFixed(1)}s (${formatBytes(Math.round(bytesIn / Math.max(secs, 0.001)))}/s, ${c.workers} workers).`,
    `Replacements: ${num(total.replacements)}`,
    ...Object.entries(total.counts).sort((a, b) => b[1]! - a[1]!).map(([type, n]) => `  ${type.padEnd(12)} ${num(n!)}`),
  ];
  const fieldRows = Object.entries(total.byField).filter(([p]) => p !== "(text)").map(([p, k]) => [p, Object.entries(k).map(([t, n]) => `${t} ${num(n)}`).join(", ")] as const);
  if (fieldRows.length) text.push("By field:", ...fieldRows.slice(0, 30).map(([p, k]) => `  ${p.padEnd(28)} ${k}`), ...(fieldRows.length > 30 ? [`  and ${fieldRows.length - 30} more fields (see the report)`] : []));
  if (total.invalidJson) text.push(`JSON lines scrubbed as plain text (not valid JSON, or holding a number too large to rewrite): ${num(total.invalidJson)}`);
  if (total.oversized) text.push(`Records over 4 MiB (scrubbed as plain text in pieces): ${num(total.oversized)}`);
  if (resumed) text.push(`Already done in an earlier run and kept: ${num(resumed)} files`);
  if (skipped.length) text.push(`Skipped: ${num(skipped.length)} (listed in the report)`);
  for (const e of errors.slice(0, 20)) text.push(`Failed: ${e.path}: ${e.error}`);
  let code = errors.length ? 2 : 0;
  if (f.audit !== false && !errors.length && done.length) {
    if (options.mode === "synthetic") text.push("Residual check skipped: synthetic values look like real ones, so a re-scan cannot tell them apart.");
    else {
      const a = await audit(c, outPath, { policy: f.policy?.rules, maxResidual: f.maxResidual });
      data.audit = a.data;
      text.push(...a.text);
      code = Math.max(code, a.code);
    }
  }
  const reportPath = path.resolve(f.report ?? `${outPath}.scrub-report.json`);
  await writeAtomic(reportPath, JSON.stringify(data, null, 2) + "\n");
  text.push(`Output: ${outPath}`, `Report: ${reportPath}`, "Detection is pattern and dictionary based. Sample the output before you rely on it.");
  return { code, data, text };
}

/* ------------------------------------------------------------------ plan and audit */

const SAMPLE_BLOCKS = 16; // about 4 MB from the start of each file

/** Samples the data and writes a policy: every field path, what was found in it, and a suggested action. */
export async function plan(c: Common, input: string, output?: string): Promise<Out> {
  if (!output) throw new UsageError("plan needs an output path: outrich plan <file|dir|zip> -o policy.json");
  const { tasks, skipped } = recordTasks(input);
  const total = newTally(), errors: Failure[] = [];
  await withPool(c, {}, "plan", [], 1, (ctx) => eachLimit(tasks, c.workers, async (task) => {
    try { addTally(total, await readRecords(ctx, task, "plan", SAMPLE_BLOCKS)); } catch (e) { errors.push({ path: task.rel, error: (e as Error).message }); }
  }));
  const fields: PolicyFile["fields"] = Object.keys(total.plan).sort().map((p) => {
    const f = total.plan[p];
    // The rule the scrub applies by default, and why, as seen most often in the sample.
    const whys = Object.entries(f.why).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)), most = whys[0][0], byRule = most.slice(0, most.indexOf("|")), why = most.slice(most.indexOf("|") + 1);
    const top = Object.entries(f.types).sort((a, b) => b[1] - a[1])[0];
    const rule = byRule ? { action: "scrub" as const, type: byRule as PiiType, reason: why }
      : top && top[1] >= f.n / 2 && f.whole >= f.n / 2 ? { action: "scrub" as const, type: top[0] as PiiType, reason: `${top[0]} detected as the whole value in most of the sample` }
      : top || f.text ? { action: "text" as const, reason: top ? `${why}; ${Object.keys(f.types).join(", ")} seen in the sample` : why }
      : f.numeric === f.n ? { action: "keep" as const, reason: "numbers only, nothing detected in the sample" }
      : { action: "keep" as const, reason: "short values without spaces, nothing detected in the sample" };
    // The same path can mean different things in different files or records ("name" in clients and in templates).
    const kinds = new Set(Object.keys(f.why).map((k) => k.slice(0, k.indexOf("|"))));
    if (kinds.size > 1) rule.reason = `decided differently across files or records (${whys.map(([k, n]) => `${k.slice(k.indexOf("|") + 1)}: ${n}`).join("; ")}). Delete this entry to let each record decide`;
    return { path: p, ...rule, coverage: Math.min(1, Math.round((f.n / Math.max(1, total.records)) * 1000) / 1000), detected: f.types, sample: f.sample };
  });
  const policy: PolicyFile = { version: POLICY_VERSION, tool: "outrich", created: new Date().toISOString(), sampledRecords: total.records, fields };
  const dest = path.resolve(output);
  await writeAtomic(dest, JSON.stringify(policy, null, 2) + "\n");
  const text = [`Sampled ${num(total.records)} records from ${num(tasks.length)} file${tasks.length === 1 ? "" : "s"}. ${num(fields.length)} field paths.`,
    `  ${"field".padEnd(30)} ${"action".padEnd(14)} ${"filled".padStart(6)}  ${"sample (letters, digits hidden)".padEnd(32)}  why`,
    ...fields.slice(0, 60).map((f) => `  ${f.path.padEnd(30)} ${(f.action === "scrub" ? `scrub ${f.type}` : f.action).padEnd(14)} ${(f.coverage * 100).toFixed(0).padStart(5)}%  ${f.sample.slice(0, 32).padEnd(32)}  ${f.reason}`),
    ...(fields.length > 60 ? [`  and ${fields.length - 60} more (see the file)`] : []),
    ...errors.map((e) => `Failed: ${e.path}: ${e.error}`),
    `Policy: ${dest}`, "Review it, edit the actions (keep, scrub, text, hash, drop), then run: outrich scrub <input> -o <out> --policy " + path.basename(dest)];
  return { code: errors.length ? 2 : 0, data: { policy: dest, sampledRecords: total.records, files: tasks.length, fields, skipped, errors }, text };
}

/** Re-scans scrubbed output with the detectors and the field-name rules, and reports what still looks like personal data. */
export async function audit(c: Common, input: string, o: { policy?: Policy; maxResidual?: number } = {}): Promise<Out> {
  const { tasks, skipped } = recordTasks(input);
  const total = newTally(), errors: Failure[] = [];
  await withPool(c, { policy: o.policy }, "audit", tasks, 1, (ctx) => eachLimit(tasks, c.workers, async (task) => {
    try { addTally(total, await readRecords(ctx, task, "audit")); } catch (e) { errors.push({ path: task.rel, error: (e as Error).message }); }
  }));
  const residual = Object.entries(total.residual as Residual).flatMap(([p, types]) => Object.entries(types).map(([type, r]) => ({ path: p, type, count: r.n, samples: r.samples }))).sort((a, b) => b.count - a.count);
  const byType: Record<string, number> = {};
  for (const r of residual) byType[r.type] = (byType[r.type] ?? 0) + r.count;
  const max = o.maxResidual ?? 0, gated = Object.fromEntries(GATED.map((t) => [t, byType[t] ?? 0]));
  const ok = !errors.length && GATED.every((t) => gated[t] <= max);
  const text = [`Residual check: ${num(total.records)} records in ${num(tasks.length)} file${tasks.length === 1 ? "" : "s"} re-scanned.`];
  if (!residual.length) text.push("  Nothing that looks like personal data was found.");
  else text.push(`  ${"field".padEnd(28)} ${"type".padEnd(12)} ${"count".padStart(9)}  shape of what was found`, ...residual.slice(0, 40).map((r) => `  ${r.path.padEnd(28)} ${r.type.padEnd(12)} ${num(r.count).padStart(9)}  ${r.samples.join(" | ")}`), ...(residual.length > 40 ? [`  and ${residual.length - 40} more rows (use --json)`] : []));
  for (const e of errors) text.push(`Failed: ${e.path}: ${e.error}`);
  text.push(ok ? `Residual check PASS: EMAIL, PHONE, SSN and CARD are each at or under ${max}.${residual.length ? " Other rows are for a person to review." : ""}`
    : `Residual check FAIL: ${GATED.filter((t) => gated[t] > max).map((t) => `${t} ${num(gated[t])}`).join(", ")} over the limit of ${max}.`);
  return { code: ok ? 0 : 2, data: { ok, records: total.records, files: tasks.length, maxResidual: max, gated, byType, residual, skipped, errors }, text };
}

/* ------------------------------------------------------------------ secrets */

/** `sink` receives each finding as one JSON line. */
export async function secrets(c: Common, input: string, sink: (line: string) => void | Promise<void>): Promise<Out> {
  const { root, files, skipped } = inputs(input);
  const tasks: Task[] = [];
  for (const e of files) {
    const why = root ? skipReason(e.rel.replace(/\.gz$/i, ""), 0) : "";
    if (why) skipped.push({ path: e.rel, reason: why }); else tasks.push({ ...e, fmt: "text", gz: isGz(e.rel) });
  }
  const by: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }, byType: Record<string, number> = {};
  let total = 0, hitFiles = 0;
  const errors: Failure[] = [];
  await withPool(c, {}, "secrets", tasks, 1, (ctx) => eachLimit(tasks, c.workers, async (task) => {
    let line = 0, hits = 0;
    const shown = root ? task.rel : input;
    try {
      await stream(ctx, task, lineScanner(), (b, i) => {
        if (i === 0 && isBinary(b.bytes)) { skipped.push({ path: task.rel, reason: "binary content" }); return null; }
        return { kind: "secrets", bytes: b.bytes, path: shown };
      }, async (r) => {
        for (const f of r.findings!) {
          hits++; by[f.severity]++; byType[f.ruleId] = (byType[f.ruleId] ?? 0) + 1;
          await sink(JSON.stringify({ file: f.path, line: f.line + line, column: f.column, type: f.ruleId, severity: f.severity, preview: f.preview, placeholder: f.placeholder }) + "\n");
        }
        line += r.lines!;
      });
    } catch (e) { errors.push({ path: task.rel, error: (e as Error).message }); }
    total += hits; if (hits) hitFiles++;
  }));
  const text = [...errors.map((e) => `Failed: ${e.path}: ${e.error}`), total
    ? `${num(total)} possible secret${total === 1 ? "" : "s"} in ${num(hitFiles)} of ${num(tasks.length)} files (critical ${by.critical}, high ${by.high}, medium ${by.medium}, low ${by.low}). ${num(skipped.length)} files skipped.`
    : `No secrets found in ${num(tasks.length)} files. ${num(skipped.length)} files skipped.`];
  return { code: errors.length ? 2 : total ? 1 : 0, data: { findings: total, files: tasks.length, filesWithFindings: hitFiles, bySeverity: by, byType, skipped: skipped.length, errors }, text };
}

/* ------------------------------------------------------------------ manifest and verify */

// The website decides which files get a line count. Asking its own function keeps the two in step.
const countsLines = async (rel: string) => "records" in (await describeFile(rel, new Blob([])));

// A zip entry is hashed on the main thread as it is unpacked; a plain file is hashed by a worker.
async function hashEntry(ctx: Ctx, e: Entry, lines: boolean): Promise<{ size: number; sha256: string; lines?: number }> {
  if (!e.zip) { const r = await ctx.pool.run({ kind: "hash", path: e.abs, countLines: lines }); return { size: r.size!, sha256: r.sha256!, lines: r.lines }; }
  const h = createHash("sha256");
  let size = 0, newlines = 0, last = 10;
  for await (const c of openInput({ abs: e.abs, gz: false, zip: e.zip }, ctx.progress.add)) {
    h.update(c); size += c.length;
    if (lines && c.length) { for (let i = c.indexOf(10); i !== -1; i = c.indexOf(10, i + 1)) newlines++; last = c[c.length - 1]; }
  }
  return { size, sha256: h.digest("hex"), ...(lines ? { lines: newlines + (last === 10 ? 0 : 1) } : {}) };
}

type Hashed = ManifestFile & { mtimeMs: number };
async function hashAll(c: Common, label: string, files: Entry[], state: State<Hashed> | null) {
  const out: ManifestFile[] = [], errors: Failure[] = [];
  await withPool(c, {}, label, files, 1, (ctx) => eachLimit(files, c.workers, async (e) => {
    const saved = state?.get(e);
    if (saved) { const { mtimeMs: _m, ...file } = saved; out.push(file); ctx.progress.add(e.size); return; }
    try {
      const r = await hashEntry(ctx, e, await countsLines(e.rel));
      const file: ManifestFile = { path: e.rel, size: r.size, sha256: r.sha256, ...(r.lines !== undefined ? { records: r.lines } : {}) };
      out.push(file);
      state?.add({ ...file, mtimeMs: e.mtimeMs });
    } catch (err) { errors.push({ path: e.rel, error: (err as Error).message }); }
  }));
  return { files: out, errors };
}

/** A folder or a .zip: the two things a manifest can describe. */
function tree(input: string, exclude: (abs: string) => boolean) {
  if (!isDir(input) && !(isZip(input) && fs.existsSync(input))) throw new UsageError(`${input} is not a folder or a .zip file.`);
  return inputs(input, exclude);
}

export async function manifest(c: Common, dir: string, output?: string): Promise<Out> {
  if (!output) throw new UsageError("manifest needs an output path: outrich manifest <dir|zip> -o manifest.json");
  const dest = path.resolve(output), started = Date.now();
  const { root, files, skipped } = tree(dir, (abs) => abs === dest || abs === dest + ".partial");
  const state = new State<Hashed>(path.join(path.dirname(dest), STATE_FILE), JSON.stringify(["manifest", root]), c.resume);
  const hashed = await hashAll(c, "manifest", files, state);
  if (hashed.errors.length) return { code: 2, data: { errors: hashed.errors }, text: [...hashed.errors.map((e) => `Failed: ${e.path}: ${e.error}`), "No manifest written: some files could not be read. Fix them and run again with --resume."] };
  const m = await buildManifest(hashed.files);
  await writeAtomic(dest, JSON.stringify(m, null, 2) + "\n"); // the same bytes the website tool downloads
  state.finish();
  const secs = (Date.now() - started) / 1000;
  return {
    code: 0, data: { manifest: dest, manifestHash: m.manifestHash, totals: m.totals, created: m.created, durationMs: Date.now() - started, skipped },
    text: [`Manifest: ${dest}`, `Files: ${num(m.totals.files)}  Size: ${formatBytes(m.totals.bytes)} (${num(m.totals.bytes)} bytes)  Time: ${secs.toFixed(1)}s (${formatBytes(Math.round(m.totals.bytes / Math.max(secs, 0.001)))}/s)`,
      `Manifest hash: ${m.manifestHash}`, ...skipped.map((s) => `Skipped: ${s.path} (${s.reason})`)],
  };
}

export async function verify(c: Common, dir: string, manifestPath?: string): Promise<Out> {
  if (!manifestPath) throw new UsageError("verify needs a manifest: outrich verify <dir|zip> <manifest.json>");
  const file = path.resolve(manifestPath);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { throw new UsageError(`Cannot read ${manifestPath}.`); }
  const m = parseManifest(raw);
  const { files, skipped } = tree(dir, (abs) => abs === file);
  const hashed = await hashAll(c, "verify", files, null);
  const v = verifyManifest(m, hashed.files);
  const ok = v.ok && v.counts.extra === 0 && !hashed.errors.length;
  const bad = v.results.filter((r) => r.status !== "match");
  const text = [`Manifest hash: ${m.manifestHash}`,
    `match ${num(v.counts.match)}  mismatch ${num(v.counts.mismatch)}  size ${num(v.counts.size)}  missing ${num(v.counts.missing)}  extra ${num(v.counts.extra)}`,
    ...bad.slice(0, 50).map((r) => `  ${r.status.padEnd(8)} ${r.path}`), ...(bad.length > 50 ? [`  and ${num(bad.length - 50)} more (use --json for the full list)`] : []),
    ...hashed.errors.map((e) => `  unreadable ${e.path}: ${e.error}`),
    ok ? "PASS: every file in the manifest is present with the same size and SHA-256, and there are no extra files."
      : !m.files.length ? "FAIL: the manifest lists no files." : "FAIL: the folder does not match the manifest."];
  return { code: ok ? 0 : 1, data: { ok, manifestHash: m.manifestHash, manifestCreated: m.created, counts: v.counts, differences: bad.map((r) => ({ path: r.path, status: r.status })), errors: hashed.errors, skipped }, text };
}

/* ------------------------------------------------------------------ profile */

export async function profile(c: Common, input: string): Promise<Out> {
  const { tasks, skipped } = recordTasks(input);
  const perFile: { path: string; format: Format; bytes: number; records: number; approxTokens: number; personalData: Tally["counts"]; fields: Record<string, number> }[] = [];
  const errors: Failure[] = [];
  await withPool(c, {}, "profile", tasks, 1, (ctx) => eachLimit(tasks, c.workers, async (task) => {
    try {
      const t = await readRecords(ctx, task, "profile");
      perFile.push({ path: task.rel, format: task.fmt, bytes: task.size, records: t.records, approxTokens: approxTokens(t.chars), personalData: t.counts, fields: t.fields });
    } catch (e) { errors.push({ path: task.rel, error: (e as Error).message }); }
  }));
  perFile.sort(byPath);
  const total = { files: perFile.length, bytes: 0, records: 0, approxTokens: 0, personalData: {} as Record<string, number> };
  for (const f of perFile) {
    total.bytes += f.bytes; total.records += f.records; total.approxTokens += f.approxTokens;
    for (const [k, n] of Object.entries(f.personalData)) total.personalData[k] = (total.personalData[k] ?? 0) + n!;
  }
  const hits = Object.entries(total.personalData).sort((a, b) => b[1] - a[1]);
  const text = [`Files: ${num(total.files)}  Size: ${formatBytes(total.bytes)}  Records: ${num(total.records)}  Approx. tokens: ${num(total.approxTokens)}`,
    hits.length ? "Personal data hits (pattern and dictionary based):" : "No personal data patterns found.", ...hits.map(([type, n]) => `  ${type.padEnd(12)} ${num(n)}`)];
  for (const f of perFile.slice(0, 20)) {
    const names = Object.keys(f.fields).filter((k) => k !== "(text)");
    if (!names.length) continue;
    text.push(`Field coverage, ${f.path} (${num(f.records)} records):`, ...names.slice(0, 40).map((k) => `  ${k.padEnd(24)} ${((f.fields[k] / Math.max(1, f.records)) * 100).toFixed(1).padStart(5)}%`));
    if (names.length > 40) text.push(`  and ${names.length - 40} more fields (use --json)`);
  }
  if (perFile.length > 20) text.push(`Field coverage is shown for the first 20 files. Use --json for all ${num(perFile.length)}.`);
  if (skipped.length) text.push(`Skipped: ${num(skipped.length)} files`);
  for (const e of errors) text.push(`Failed: ${e.path}: ${e.error}`);
  return { code: errors.length ? 2 : 0, data: { totals: total, files: perFile, skipped, errors }, text };
}

/* ------------------------------------------------------------------ convert */

export async function convert(c: Common, input: string, output?: string): Promise<Out> {
  if (!output) throw new UsageError("convert needs an output path: outrich convert <in> -o <out>");
  const { root, files } = inputs(input);
  if (root) throw new UsageError("convert works on one file at a time.");
  const task: Task = { ...files[0], fmt: formatOf(files[0].rel), gz: isGz(files[0].rel) }, dest = path.resolve(output), to = formatOf(dest);
  if (!((task.fmt === "csv" && to === "jsonl") || (task.fmt === "jsonl" && to === "csv")))
    throw new UsageError("convert goes between CSV or TSV and JSONL. Name the files .csv, .tsv, .jsonl or .ndjson (add .gz for gzip).");
  if (fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(task.abs)) throw new UsageError("The output file is the input file.");
  const started = Date.now();
  let records = 0, invalid = 0;
  await withPool(c, {}, "convert", files, to === "csv" ? 2 : 1, async (ctx) => {
    const out = await openOutput(dest, isGz(dest));
    try {
      const take = async (r: Result) => { records += r.records!; invalid += r.invalid!; await out.write(r.out!); };
      if (to === "jsonl") {
        const { delim, names } = await csvInfo(task);
        await stream(ctx, task, csvScanner(delim.charCodeAt(0)), (b, i) => ({ kind: "convert", to, ...b, header: names, delim, first: i === 0 }), take);
      } else {
        // First pass: the column list is every key, in the order first seen. Second pass: write the rows.
        const header: string[] = [], seen = new Set<string>();
        await stream(ctx, task, lineScanner(), (b) => ({ kind: "keys", ...b }), (r) => { for (const k of r.keys!) if (!seen.has(k)) { seen.add(k); header.push(k); } });
        const delim = /\.tsv(\.gz)?$/i.test(dest) ? "\t" : ",";
        await out.write(csvLine(header, delim));
        await stream(ctx, task, lineScanner(), (b) => ({ kind: "convert", to, ...b, header, delim }), take);
      }
      await out.commit();
    } catch (e) { await out.abort(); throw e; }
  });
  const text = [`Converted ${num(records)} records in ${((Date.now() - started) / 1000).toFixed(1)}s.`];
  if (invalid) text.push(`Left out: ${num(invalid)} ${to === "csv" ? "lines that are not valid JSON" : "records over 4 MiB"}.`);
  text.push(`Output: ${dest}`);
  return { code: invalid ? 1 : 0, data: { output: dest, records, skippedRecords: invalid, durationMs: Date.now() - started }, text };
}
