// File system plumbing: safe directory walks, streamed input, atomic output, resume state, progress.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { once } from "node:events";
import { finished, pipeline } from "node:stream/promises";
import { pipeline as pipe, Readable } from "node:stream";
import { openZipEntry, transform, type Pre, type ZipRef } from "./sources.ts";
import { BLOCK } from "./blocks.ts";
import { formatBytes } from "./lib/manifest.ts";

export type Entry = { rel: string; abs: string; size: number; mtimeMs: number; zip?: ZipRef };
export type Skipped = { path: string; reason: string };
export const STATE_FILE = ".outrich-state.jsonl";

/** True when `child` is `parent` or lies below it. */
export function inside(parent: string, child: string): boolean {
  const r = path.relative(parent, child);
  return r === "" || (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r));
}

/**
 * Lists the regular files under `root`, sorted by path. A symbolic link is followed only when it
 * points to a regular file inside `root`; links to folders and links that leave `root` are skipped and reported.
 */
export function walk(root: string, exclude: (abs: string) => boolean = () => false) {
  const realRoot = fs.realpathSync(root);
  const files: Entry[] = [], skipped: Skipped[] = [];
  const visit = (dir: string, rel: string) => {
    let list: fs.Dirent[];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { skipped.push({ path: rel || ".", reason: `cannot read folder: ${(e as Error).message}` }); return; }
    for (const d of list) {
      const abs = path.join(dir, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      if (d.name === STATE_FILE || exclude(abs)) continue;
      try {
        if (d.isSymbolicLink()) {
          const target = fs.realpathSync(abs), st = fs.statSync(target);
          if (!inside(realRoot, target)) skipped.push({ path: r, reason: "symbolic link that points outside the input folder" });
          else if (!st.isFile()) skipped.push({ path: r, reason: "symbolic link to a folder" });
          else files.push({ rel: r, abs, size: st.size, mtimeMs: st.mtimeMs });
        } else if (d.isDirectory()) visit(abs, r);
        else if (d.isFile()) { const st = fs.statSync(abs); files.push({ rel: r, abs, size: st.size, mtimeMs: st.mtimeMs }); }
        else skipped.push({ path: r, reason: "not a regular file" });
      } catch (e) { skipped.push({ path: r, reason: `cannot read: ${(e as Error).message}` }); }
    }
  };
  visit(root, "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped };
}

export type Source = { abs: string; gz: boolean; zip?: ZipRef; pre?: Pre };
/** Streams a file or a zip entry, gunzipping when asked, and turning mail and JSON documents into JSON Lines. `onBytes` sees the bytes read from disk. */
export function openInput(src: Source, onBytes: (n: number) => void = () => {}): AsyncIterable<Buffer> {
  let stream: AsyncIterable<Buffer>;
  if (src.zip) stream = openZipEntry(src.zip, onBytes);
  else {
    const file = fs.createReadStream(src.abs, { highWaterMark: BLOCK });
    stream = (async function* () { for await (const c of file) { onBytes(c.length); yield c as Buffer; } })();
  }
  if (src.gz) stream = pipe(Readable.from(stream), zlib.createGunzip({ chunkSize: BLOCK }), () => {});
  return src.pre ? transform(stream, src.pre) : stream;
}

const partials = new Set<string>();
/** Removes every unfinished output. Called on Ctrl-C. */
export function dropPartials() {
  for (const p of partials) try { fs.unlinkSync(p); } catch { /* still open on Windows: it keeps the .partial name, which never passes for a finished file */ }
}

/** Output goes to `<dest>.partial` and takes the real name only once every byte is written. */
export async function openOutput(dest: string, gz: boolean) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const partial = dest + ".partial";
  const handle = await fs.promises.open(partial, "w");
  partials.add(partial);
  const file = handle.createWriteStream();
  const gzip = gz ? zlib.createGzip() : null, head = gzip ?? file;
  let failure: Error | null = null;
  const done = gzip ? pipeline(gzip, file) : finished(file);
  done.catch((e) => { failure = e; });
  return {
    async write(bytes: Uint8Array) {
      if (failure) throw failure;
      if (bytes.length && !head.write(bytes)) await Promise.race([once(head, "drain"), done]);
    },
    /** Returns the size of the finished file. */
    async commit() {
      head.end();
      await done;
      await fs.promises.rename(partial, dest);
      partials.delete(partial);
      return (await fs.promises.stat(dest)).size;
    },
    async abort() {
      head.destroy(); file.destroy();
      await done.catch(() => {});
      await fs.promises.rm(partial, { force: true }).catch(() => {});
      partials.delete(partial);
    },
  };
}

export async function writeAtomic(dest: string, text: string) {
  const out = await openOutput(dest, false);
  try { await out.write(Buffer.from(text)); await out.commit(); } catch (e) { await out.abort(); throw e; }
}

/**
 * Resume state: one JSON line per finished file, appended as each file completes. The first line
 * holds a key built from the command and its options; a run with different options refuses to resume.
 * The file is removed when a run finishes without errors.
 */
export class State<T extends { path: string; size: number; mtimeMs: number }> {
  readonly done = new Map<string, T>();
  constructor(private file: string, key: string, resume: boolean) {
    if (resume && fs.existsSync(file)) {
      const [head, ...lines] = fs.readFileSync(file, "utf8").split("\n");
      let saved = "";
      try { saved = JSON.parse(head).key; } catch { /* unreadable header: treated as a different run */ }
      if (saved !== key) throw new Error(`${file} belongs to a run with different options or input. Delete it, or run without --resume.`);
      for (const l of lines) try { const e = JSON.parse(l) as T; this.done.set(e.path, e); } catch { /* a torn last line from an interrupted run */ }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ key }) + "\n");
    }
  }
  /** The saved entry when `e` has not changed since it was processed. */
  get(e: Entry): T | undefined {
    const d = this.done.get(e.rel);
    return d && d.size === e.size && d.mtimeMs === e.mtimeMs ? d : undefined;
  }
  add(entry: T) { fs.appendFileSync(this.file, JSON.stringify(entry) + "\n"); }
  finish() { fs.rmSync(this.file, { force: true }); }
}

const clock = (s: number) => (!Number.isFinite(s) ? "?" : s < 60 ? `${Math.ceil(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);

/** Bytes done, rate and ETA on stderr: redrawn in place on a terminal, one line every 10 seconds otherwise. */
export class Progress {
  private done = 0;
  private started = Date.now();
  private timer?: NodeJS.Timeout;
  private tty = process.stderr.isTTY;
  constructor(private label: string, private total: number, enabled: boolean) {
    if (enabled) { this.timer = setInterval(() => this.draw(), this.tty ? 200 : 10_000); this.timer.unref(); }
  }
  add = (n: number) => { this.done += n; };
  private draw() {
    const secs = (Date.now() - this.started) / 1000, rate = this.done / Math.max(secs, 0.001);
    const line = `${this.label}: ${formatBytes(this.done)} of ${formatBytes(this.total)} (${this.total ? Math.min(100, Math.floor((this.done / this.total) * 100)) : 100}%), ${formatBytes(Math.round(rate))}/s, ETA ${clock((this.total - this.done) / rate)}`;
    process.stderr.write(this.tty ? `\r${line}\x1b[K` : `${line}\n`);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    if (this.tty) process.stderr.write("\r\x1b[K");
  }
}
