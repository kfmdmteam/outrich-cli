// Cuts a byte stream into blocks that end on a record boundary, so each block can be handed to a
// worker on its own. Memory is bounded: a block is about BLOCK bytes, and a record that never ends
// is cut into raw pieces once it passes MAX_LINE.

export const BLOCK = 256 * 1024;
export const MAX_LINE = 4 * 1024 * 1024; // 4 MiB

/** `raw`: a piece of a record longer than MAX_LINE, to be treated as plain text. `endsLine`: the piece closes its record. */
export type Block = { bytes: Uint8Array; raw: boolean; endsLine: boolean };

/** Scans one chunk and returns the offsets just past the first and the last safe record end in it (0 when none). */
export type Scanner = { scan(chunk: Buffer): [first: number, last: number]; reset(): void };

/** Every "\n" ends a record. */
export const lineScanner = (): Scanner => ({ scan: (c) => [c.indexOf(10) + 1, c.lastIndexOf(10) + 1], reset() {} });

/**
 * A "\n" ends a record only outside a quoted field. This follows the same rules as parseCsv in
 * lib/profile.ts byte for byte: a quote opens a quoted field only at the start of a field, and a
 * doubled quote inside a quoted field is a literal quote.
 */
export function csvScanner(delimiter: number): Scanner {
  // 0: start of a field. 1: inside an unquoted field. 2: inside quotes. 3: saw a quote inside quotes (close or first half of "").
  let st = 0;
  return {
    reset() { st = 0; },
    scan(c) {
      let first = 0, last = 0;
      for (let i = 0; i < c.length; i++) {
        const b = c[i];
        if (st === 2) {
          i = c.indexOf(34, i);
          if (i === -1) break;
          st = 3;
          continue;
        }
        if (st === 3) {
          if (b === 34) { st = 2; continue; }
          st = 1;
        }
        if (b === 34) { if (st === 0) st = 2; }
        else if (b === delimiter || b === 13) st = 0;
        else if (b === 10) { st = 0; last = i + 1; if (!first) first = last; }
        else st = 1;
      }
      return [first, last];
    },
  };
}

// The end of `b`, or the start of its last character when that character is cut off mid-sequence.
function utf8End(b: Buffer): number {
  for (let i = b.length - 1, k = 0; i >= 0 && k < 4; i--, k++) {
    const c = b[i];
    if (c < 0x80) break;
    if (c >= 0xc0) return b.length - i < (c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2) ? i : b.length;
  }
  return b.length;
}

// Where to cut a record that is too long: after the last space or tab in the final 64 KB, so that an
// email address or a key is not split in two; failing that, on a character boundary.
function rawCut(b: Buffer): number {
  const end = utf8End(b);
  for (let i = end - 1; i > 0 && i >= end - 65536; i--) if (b[i] === 32 || b[i] === 9) return i + 1;
  return end;
}

// A copy with its own ArrayBuffer, so it can be transferred to a worker (Node pools small Buffers).
const own = (b: Buffer) => { const u = new Uint8Array(b.length); u.set(b); return u; };

async function* withoutBom(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let head: Buffer | null = Buffer.alloc(0);
  for await (const chunk of src) {
    if (!head) { yield chunk; continue; }
    head = head.length ? Buffer.concat([head, chunk]) : chunk;
    if (head.length < 3) continue;
    yield head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head;
    head = null;
  }
  if (head?.length) yield head;
}

export async function* blocks(source: AsyncIterable<Buffer>, scanner: Scanner = lineScanner(), size = BLOCK, maxLine = MAX_LINE): AsyncGenerator<Block> {
  let carry: Buffer = Buffer.alloc(0), first = 0, last = 0, raw = false;
  for await (const chunk of withoutBom(source)) {
    if (!chunk.length) continue;
    const [f, l] = scanner.scan(chunk);
    if (f && !first) first = carry.length + f;
    if (l) last = carry.length + l;
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    if (raw) {
      if (first) { // the long record ends here
        yield { bytes: own(carry.subarray(0, first)), raw: true, endsLine: true };
        carry = carry.subarray(first); last -= first; first = 0; raw = false;
        if (last > 0) { yield { bytes: own(carry.subarray(0, last)), raw: false, endsLine: true }; carry = carry.subarray(last); last = 0; }
      } else if (carry.length >= size) {
        const cut = rawCut(carry);
        yield { bytes: own(carry.subarray(0, cut)), raw: true, endsLine: false };
        carry = carry.subarray(cut);
      }
    } else if (carry.length >= size) {
      if (last) {
        yield { bytes: own(carry.subarray(0, last)), raw: false, endsLine: true };
        carry = carry.subarray(last); first = last = 0;
      } else if (carry.length >= maxLine) {
        raw = true; scanner.reset();
        const cut = rawCut(carry);
        yield { bytes: own(carry.subarray(0, cut)), raw: true, endsLine: false };
        carry = carry.subarray(cut);
      }
    }
  }
  if (carry.length) yield { bytes: own(carry), raw, endsLine: true };
}
