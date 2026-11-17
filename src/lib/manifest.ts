// Delivery manifests: incremental hashing, checksum manifest build and verify.
// Pure and dependency-free so a browser tool, a worker and a deal room can share it. Tested by `npm test`.

export type ManifestFile = { path: string; size: number; sha256: string; records?: number };
export type Manifest = {
  version: 1;
  created: string;
  algorithm: "SHA-256";
  files: ManifestFile[];
  totals: { files: number; bytes: number };
  manifestHash: string;
};
export type VerifyStatus = "match" | "mismatch" | "missing" | "extra" | "size";
export type VerifyResult = {
  ok: boolean;
  results: { path: string; status: VerifyStatus; expected?: ManifestFile; actual?: ManifestFile }[];
  counts: Record<string, number>;
};

// ---- Incremental hashing ------------------------------------------------------------------------
// crypto.subtle.digest needs the whole input in memory, so multi-GB files need a streaming hasher.
// SHA-1 and MD5 exist only for comparing against legacy checksums. They are not secure.

export type HashAlgo = "SHA-256" | "SHA-1" | "MD5";
export type Hasher = { update(data: Uint8Array): void; digest(): string };

const words = (hex: string) => Int32Array.from(hex.trim().split(/\s+/), (h) => parseInt(h, 16) | 0);

// Constants are written out, not derived from Math.cbrt / Math.sin, whose last bits may differ between engines.
const K256 = words(`
  428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174
  e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967
  27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070
  19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2`);
const KMD5 = words(`
  d76aa478 e8c7b756 242070db c1bdceee f57c0faf 4787c62a a8304613 fd469501 698098d8 8b44f7af ffff5bb1 895cd7be 6b901122 fd987193 a679438e 49b40821
  f61e2562 c040b340 265e5a51 e9b6c7aa d62f105d 02441453 d8a1e681 e7d3fbc8 21e1cde6 c33707d6 f4d50d87 455a14ed a9e3e905 fcefa3f8 676f02d9 8d2a4c8a
  fffa3942 8771f681 6d9d6122 fde5380c a4beea44 4bdecfa9 f6bb4b60 bebfbc70 289b7ec6 eaa127fa d4ef3085 04881d05 d9d4d039 e6db99e5 1fa27cf8 c4ac5665
  f4292244 432aff97 ab9423a7 fc93a039 655b59c3 8f0ccc92 ffeff47d 85845dd1 6fa87e4f fe2ce6e0 a3014314 4e0811a1 f7537e82 bd3af235 2ad7d2bb eb86d391`);
const SMD5 = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const W = new Int32Array(80);

function sha256Block(s: Int32Array, p: Uint8Array, o: number) {
  for (let i = 0; i < 16; i++, o += 4) W[i] = (p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3];
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    W[i] = (W[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
  }
  let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0; s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
}

function sha1Block(s: Int32Array, p: Uint8Array, o: number) {
  for (let i = 0; i < 16; i++, o += 4) W[i] = (p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3];
  for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
  let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4];
  for (let i = 0; i < 80; i++) {
    const f = i < 20 ? ((b & c) | (~b & d)) + 0x5a827999 : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1 : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc : (b ^ c ^ d) + 0xca62c1d6;
    const t = (((a << 5) | (a >>> 27)) + f + e + W[i]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0; s[4] = (s[4] + e) | 0;
}

function md5Block(s: Int32Array, p: Uint8Array, o: number) {
  for (let i = 0; i < 16; i++, o += 4) W[i] = p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24);
  let a = s[0], b = s[1], c = s[2], d = s[3];
  for (let i = 0; i < 64; i++) {
    let f: number, g: number;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
    else { f = c ^ (b | ~d); g = (7 * i) & 15; }
    f = (f + a + KMD5[i] + W[g]) | 0;
    const r = SMD5[((i >> 4) << 2) | (i & 3)];
    a = d; d = c; c = b; b = (b + ((f << r) | (f >>> (32 - r)))) | 0;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
}

const ALGOS: Record<HashAlgo, { init: string; block: (s: Int32Array, p: Uint8Array, o: number) => void; bigEndian: boolean }> = {
  "SHA-256": { init: "6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19", block: sha256Block, bigEndian: true },
  "SHA-1": { init: "67452301 efcdab89 98badcfe 10325476 c3d2e1f0", block: sha1Block, bigEndian: true },
  MD5: { init: "67452301 efcdab89 98badcfe 10325476", block: md5Block, bigEndian: false },
};

/** Streaming hasher. Call update() with each chunk, then digest() once for the lowercase hex result. */
export function createHasher(algo: HashAlgo = "SHA-256"): Hasher {
  const { init, block, bigEndian } = ALGOS[algo];
  const state = words(init);
  const buf = new Uint8Array(64);
  let fill = 0, bytes = 0;
  return {
    update(data) {
      bytes += data.length;
      let i = 0;
      if (fill) {
        const take = Math.min(64 - fill, data.length);
        buf.set(data.subarray(0, take), fill);
        fill += take; i = take;
        if (fill < 64) return;
        block(state, buf, 0); fill = 0;
      }
      for (; i + 64 <= data.length; i += 64) block(state, data, i);
      if (i < data.length) { buf.set(data.subarray(i)); fill = data.length - i; }
    },
    digest() {
      buf[fill++] = 0x80;
      if (fill > 56) { buf.fill(0, fill); block(state, buf, 0); fill = 0; }
      buf.fill(0, fill, 56);
      const view = new DataView(buf.buffer);
      const hi = Math.floor(bytes / 0x20000000), lo = (bytes << 3) >>> 0; // message length in bits, as two 32-bit halves
      view.setUint32(56, bigEndian ? hi : lo, !bigEndian);
      view.setUint32(60, bigEndian ? lo : hi, !bigEndian);
      block(state, buf, 0);
      const out = new DataView(new ArrayBuffer(state.length * 4));
      state.forEach((w, i) => out.setInt32(i * 4, w, !bigEndian));
      return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}

export const sha256Hex = (data: Uint8Array | string): string => {
  const h = createHasher();
  h.update(typeof data === "string" ? new TextEncoder().encode(data) : data);
  return h.digest();
};

const CHUNK = 4 * 1024 * 1024;

/** Reads a file in 4 MB slices, so memory use stays flat whatever the file size. Optionally counts lines in the same pass. */
export async function digestFile(file: Blob, algos: HashAlgo[] = ["SHA-256"], onProgress?: (fraction: number) => void, countLines = false) {
  const hashers = algos.map(createHasher);
  let newlines = 0, last = 10;
  for (let at = 0; at < file.size; at += CHUNK) {
    const bytes = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
    for (const h of hashers) h.update(bytes);
    if (countLines && bytes.length) {
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) newlines++;
      last = bytes[bytes.length - 1];
    }
    onProgress?.(Math.min(1, (at + bytes.length) / file.size));
  }
  if (!file.size) onProgress?.(1);
  return {
    hashes: Object.fromEntries(algos.map((a, i) => [a, hashers[i].digest()])) as Record<HashAlgo, string>,
    lines: countLines ? newlines + (last === 10 ? 0 : 1) : undefined,
  };
}

/** SHA-256 of a file as lowercase hex, streamed in chunks. */
export async function hashFile(file: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  return (await digestFile(file, ["SHA-256"], onProgress)).hashes["SHA-256"];
}

const TEXT_LIKE = /\.(csv|tsv|jsonl|ndjson|txt|log)$/i;

/** One manifest entry for a file. `records` is the line count, set for line-oriented text files only. */
export async function describeFile(path: string, file: Blob, onProgress?: (fraction: number) => void): Promise<ManifestFile> {
  const text = TEXT_LIKE.test(path);
  const { hashes, lines } = await digestFile(file, ["SHA-256"], onProgress, text);
  return { path: normalizePath(path), size: file.size, sha256: hashes["SHA-256"], ...(text ? { records: lines } : {}) };
}

// ---- Manifest -----------------------------------------------------------------------------------

export const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/^(\.?\/)+/, "");

/** Drops the top folder when every path shares it, so "export/a.csv" and "downloads/a.csv" both become "a.csv". */
export function stripCommonRoot(paths: string[]): string[] {
  const norm = paths.map(normalizePath);
  const root = norm[0]?.split("/")[0];
  return norm.length && norm.every((p) => p.includes("/") && p.split("/")[0] === root) ? norm.map((p) => p.slice(root.length + 1)) : norm;
}

const byPath = (a: ManifestFile, b: ManifestFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The canonical file list: JSON of [path, size, sha256] triples sorted by path. Its SHA-256 is the manifest hash. */
export const canonicalList = (files: ManifestFile[]) =>
  JSON.stringify(files.map((f) => ({ ...f, path: normalizePath(f.path) })).sort(byPath).map((f) => [f.path, f.size, f.sha256.toLowerCase()]));

export const manifestHashOf = (files: ManifestFile[]) => sha256Hex(canonicalList(files));

function clean(files: ManifestFile[]): ManifestFile[] {
  const out = files.map((f) => ({ ...f, path: normalizePath(f.path), sha256: f.sha256.toLowerCase() })).sort(byPath);
  for (let i = 1; i < out.length; i++) if (out[i].path === out[i - 1].path) throw new Error(`Two files share the path "${out[i].path}". Each path can appear once.`);
  return out;
}

export async function buildManifest(files: ManifestFile[], created: string = new Date().toISOString()): Promise<Manifest> {
  const list = clean(files);
  return {
    version: 1, created, algorithm: "SHA-256", files: list,
    totals: { files: list.length, bytes: list.reduce((n, f) => n + f.size, 0) },
    manifestHash: manifestHashOf(list),
  };
}

/** Parses and validates manifest JSON. Throws a readable Error, including when the file list no longer matches the manifest hash. */
export function parseManifest(text: string): Manifest {
  let m: Record<string, unknown>;
  try { m = JSON.parse(text); } catch { throw new Error("This file is not valid JSON. Load the manifest the sender created."); }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("This JSON is not a delivery manifest.");
  if (m.version !== 1) throw new Error("Unsupported manifest version. This tool reads version 1 manifests.");
  if (m.algorithm !== "SHA-256") throw new Error("Unsupported algorithm. This tool reads SHA-256 manifests.");
  if (!Array.isArray(m.files)) throw new Error("The manifest has no file list.");
  const files = (m.files as unknown[]).map((raw, i): ManifestFile => {
    const f = raw as Record<string, unknown>;
    const where = `File entry ${i + 1}`;
    if (!f || typeof f !== "object") throw new Error(`${where} is not an object.`);
    if (typeof f.path !== "string" || !f.path) throw new Error(`${where} has no path.`);
    if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error(`${where} (${f.path}) has an invalid size.`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(f.sha256)) throw new Error(`${where} (${f.path}) has an invalid SHA-256 value.`);
    if (f.records !== undefined && (typeof f.records !== "number" || !Number.isSafeInteger(f.records) || f.records < 0)) throw new Error(`${where} (${f.path}) has an invalid record count.`);
    return { path: f.path, size: f.size, sha256: f.sha256, ...(f.records !== undefined ? { records: f.records as number } : {}) };
  });
  const list = clean(files);
  if (typeof m.manifestHash !== "string" || !/^[0-9a-f]{64}$/i.test(m.manifestHash)) throw new Error("The manifest has no valid manifest hash.");
  if (manifestHashOf(list) !== m.manifestHash.toLowerCase()) throw new Error("The manifest hash does not match its file list. The manifest was edited or damaged after it was created.");
  return {
    version: 1, created: typeof m.created === "string" ? m.created : "", algorithm: "SHA-256", files: list,
    totals: { files: list.length, bytes: list.reduce((n, f) => n + f.size, 0) },
    manifestHash: m.manifestHash.toLowerCase(),
  };
}

/**
 * Compares received files with a manifest. `ok` is true when the manifest lists at least one file and every
 * listed file is present with the same size and hash. Extra files are reported and counted but do not fail `ok`.
 */
export function verifyManifest(manifest: Manifest, actual: ManifestFile[]): VerifyResult {
  const got = new Map(actual.map((f) => [normalizePath(f.path), f]));
  const results: VerifyResult["results"] = manifest.files.map((expected) => {
    const path = normalizePath(expected.path);
    const a = got.get(path);
    got.delete(path);
    const status: VerifyStatus = !a ? "missing" : a.size !== expected.size ? "size" : a.sha256.toLowerCase() !== expected.sha256.toLowerCase() ? "mismatch" : "match";
    return { path, status, expected, ...(a ? { actual: a } : {}) };
  });
  for (const [path, a] of got) results.push({ path, status: "extra", actual: a });
  const counts: Record<string, number> = { match: 0, mismatch: 0, missing: 0, extra: 0, size: 0 };
  for (const r of results) counts[r.status]++;
  return { ok: manifest.files.length > 0 && counts.match === manifest.files.length, results, counts };
}

// ---- Human-readable output ----------------------------------------------------------------------

export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(v < 10 ? 2 : 1) : v} ${units[i]}`;
}

const mdCell = (s: string) => s.replace(/\|/g, "\\|");

export function manifestMarkdown(m: Manifest): string {
  return [
    "# Delivery manifest", "",
    `- Created: ${m.created}`, `- Algorithm: ${m.algorithm}`, `- Files: ${m.totals.files.toLocaleString("en-US")}`,
    `- Total size: ${formatBytes(m.totals.bytes)} (${m.totals.bytes.toLocaleString("en-US")} bytes)`, `- Manifest hash: \`${m.manifestHash}\``, "",
    "Both parties compare the manifest hash. If it is the same on both sides, both hold the same list of file paths, sizes and checksums.", "",
    "| File | Size | Lines | SHA-256 |", "|---|---|---|---|",
    ...m.files.map((f) => `| ${mdCell(f.path)} | ${formatBytes(f.size)} | ${f.records?.toLocaleString("en-US") ?? ""} | \`${f.sha256}\` |`), "",
    "A matching checksum shows the bytes are identical. It says nothing about the quality or lawfulness of the content.",
  ].join("\n");
}

const STATUS_TEXT: Record<VerifyStatus, string> = {
  match: "Match", mismatch: "Hash differs", size: "Size differs", missing: "Missing", extra: "Not in manifest",
};
export const statusText = (s: VerifyStatus) => STATUS_TEXT[s];

export function verificationMarkdown(m: Manifest, v: VerifyResult, checkedAt: string): string {
  const c = v.counts;
  return [
    "# Delivery verification report", "",
    `- Result: ${v.ok ? "PASS. Every file listed in the manifest was received with the same size and SHA-256." : "FAIL. The received files do not match the manifest."}`,
    `- Checked: ${checkedAt}`, `- Manifest hash: \`${m.manifestHash}\``, `- Manifest created: ${m.created}`,
    `- Listed files: ${m.totals.files}`, `- Match: ${c.match}`, `- Hash differs: ${c.mismatch}`, `- Size differs: ${c.size}`, `- Missing: ${c.missing}`, `- Not in manifest: ${c.extra}`, "",
    "| File | Status | Expected SHA-256 | Received SHA-256 |", "|---|---|---|---|",
    ...v.results.map((r) => `| ${mdCell(r.path)} | ${STATUS_TEXT[r.status]} | ${r.expected ? `\`${r.expected.sha256}\`` : ""} | ${r.actual ? `\`${r.actual.sha256}\`` : ""} |`), "",
    "Confirm that the manifest hash above is the one the sender posted. A pass shows the received bytes equal the listed bytes. It does not assess the content.",
  ].join("\n");
}
