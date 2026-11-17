// Inputs that are not plain files of records: entries inside a .zip, mailboxes (.mbox, .eml) and
// small JSON documents. Each is turned into a byte stream of JSON Lines that the normal path reads.
import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream";
import { bytesToBinary, parseEml } from "./lib/parsers.ts";

/* ------------------------------------------------------------------ zip */

export type ZipRef = { file: string; offset: number; csize: number; method: number };
export type ZipEntry = { name: string; size: number; ref: ZipRef };

/** Reads the central directory of a .zip, zip64 included. Encrypted archives are refused. Nothing is unpacked here. */
export function zipEntries(file: string): ZipEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
    const tailLen = Math.min(size, 65557), tail = read(size - tailLen, tailLen);
    let e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
    if (e === -1) throw new Error(`${file} is not a zip file (no end record).`);
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) {
      const loc = e - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error(`${file}: zip64 locator not found.`);
      const end64 = read(Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (end64.readUInt32LE(0) !== 0x06064b50) throw new Error(`${file}: zip64 end record not found.`);
      count = Number(end64.readBigUInt64LE(32)); cdSize = Number(end64.readBigUInt64LE(40)); cdAt = Number(end64.readBigUInt64LE(48));
    }
    const cd = read(cdAt, cdSize), out: ZipEntry[] = [];
    for (let p = 0, i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: damaged central directory.`);
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
      const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
      const name = cd.toString("utf8", p + 46, p + 46 + n);
      for (let q = p + 46 + n, end = q + x; q + 4 <= end; ) { // zip64 sizes live in extra field 1, in this fixed order
        const id = cd.readUInt16LE(q), len = cd.readUInt16LE(q + 2);
        if (id === 1) {
          let at = q + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(at)); at += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(at)); at += 8; }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(at));
        }
        q += 4 + len;
      }
      p += 46 + n + x + c;
      if (name.endsWith("/")) continue;
      if (flags & 1) throw new Error(`${file} is encrypted. Unpack it first.`);
      if (method !== 0 && method !== 8) throw new Error(`${file}: entry ${name} uses compression method ${method}. Only stored and deflate are supported.`);
      out.push({ name, size: usize, ref: { file, offset, csize, method } });
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** The unpacked bytes of one zip entry, as a stream. */
export function openZipEntry(ref: ZipRef, onBytes: (n: number) => void): AsyncIterable<Buffer> {
  if (!ref.csize) return (async function* () {})();
  const fd = fs.openSync(ref.file, "r"), head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, ref.offset);
  fs.closeSync(fd);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${ref.file}: damaged entry header.`);
  const start = ref.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = fs.createReadStream(ref.file, { start, end: start + ref.csize - 1, highWaterMark: 256 * 1024 });
  raw.on("data", (c) => onBytes(c.length));
  return ref.method === 8 ? pipeline(raw, zlib.createInflateRaw({ chunkSize: 256 * 1024 }), () => {}) : raw;
}

/* ------------------------------------------------------------------ mail and JSON documents */

export type Pre = "mbox" | "eml" | "json";
export const preOf = (name: string): Pre | undefined => { const n = name.replace(/\.gz$/i, ""); return /\.mbox$/i.test(n) ? "mbox" : /\.eml$/i.test(n) ? "eml" : /\.json$/i.test(n) ? "json" : undefined; };

const MAX_MESSAGE = 32 * 1024 * 1024; // a message past this size is cut here; what is cut is nearly always attachment data
const MAX_JSON = 64 * 1024 * 1024;
const FROM_LINE = /(?:^|\n)From \S+[^\n]*\d{2}:\d{2}[^\n]*\r?\n/g;

function mailRecord(raw: string): string {
  const e = parseEml(raw.replace(/^>(>*From )/gm, "$1"));
  if (!(e.from || e.id || (e.subject && e.date))) return "";
  return JSON.stringify({ from: e.from, to: e.to, cc: e.cc, date: e.date, subject: e.subject, body: e.text, attachments: e.attachments.map((a) => a.name).filter(Boolean) }) + "\n";
}

/** One JSON line per message: {from, to, cc, date, subject, body, attachments}. MIME is decoded; attachments are named, not included. */
async function* mailToJsonl(source: AsyncIterable<Buffer>, mbox: boolean): AsyncGenerator<Buffer> {
  let buf = "", scanned = 0, skipping = false; // buf: the open message, without its "From " line
  for await (const chunk of source) {
    buf += bytesToBinary(chunk);
    const out: string[] = [];
    if (mbox || skipping) {
      // The lookback covers a separator line that was split between two chunks.
      FROM_LINE.lastIndex = Math.max(0, scanned - 1000);
      let start = 0;
      for (let m; (m = FROM_LINE.exec(buf)); ) {
        if (!skipping) out.push(mailRecord(buf.slice(start, m.index)));
        skipping = false;
        start = m.index + m[0].length;
      }
      buf = skipping ? buf.slice(-1000) : buf.slice(start);
      scanned = buf.length;
    }
    if (!skipping && buf.length > MAX_MESSAGE) { out.push(mailRecord(buf.slice(0, MAX_MESSAGE))); buf = ""; scanned = 0; skipping = true; }
    if (out.length) yield Buffer.from(out.join(""));
  }
  if (!skipping && buf.trim()) yield Buffer.from(mailRecord(buf));
}

/** A .json document as JSON Lines: one line per element of a top-level array, or one line for anything else. */
async function* jsonToJsonl(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of source) { parts.push(c); size += c.length; if (size > MAX_JSON) throw new Error("A .json document over 64 MB is not supported. Convert it to JSON Lines first."); }
  const text = Buffer.concat(parts).toString("utf8").replace(/^﻿/, "");
  if (!text.trim()) return;
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new Error("Not valid JSON."); }
  const items = Array.isArray(doc) ? doc : [doc];
  for (let i = 0; i < items.length; i += 2000) yield Buffer.from(items.slice(i, i + 2000).map((x) => JSON.stringify(x) + "\n").join(""));
}

export const transform = (source: AsyncIterable<Buffer>, pre: Pre): AsyncIterable<Buffer> => (pre === "json" ? jsonToJsonl(source) : mailToJsonl(source, pre === "mbox"));
