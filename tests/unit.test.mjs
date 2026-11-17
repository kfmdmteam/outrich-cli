import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BIN } from "./helpers.mjs";
import { blocks, csvScanner, lineScanner, createWorker, createScrubber } from "../dist/outrich.mjs";
import * as upstream from "./.build/upstream-pii.mjs";
import { ticket } from "../scripts/gen.mjs";

const enc = new TextEncoder(), dec = new TextDecoder();
async function* chunked(bytes, size) { for (let i = 0; i < bytes.length; i += size) yield Buffer.from(bytes.subarray(i, i + size)); }
const collect = async (it) => { const out = []; for await (const b of it) out.push(b); return out; };
const joined = (list) => Buffer.concat(list.map((b) => Buffer.from(b.bytes)));

/* ---------------------------------------------------------------- no network */

const imports = (src) => [...src.matchAll(/^import\s(?:[^;"']*?\sfrom\s*)?["']([^"']+)["'];?\s*$/gm), ...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g), ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1].replace(/^node:/, ""));
const NETWORK = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /process\.binding/];

test("the main program imports only local Node modules and has no network call; the connectors are a separate file loaded on demand", () => {
  const src = fs.readFileSync(BIN, "utf8");
  const allowed = new Set(["fs", "path", "os", "zlib", "crypto", "worker_threads", "util", "url", "events", "stream", "stream/promises"]);
  const found = imports(src);
  assert.ok(found.length >= 8, "expected to find the bundle's imports");
  for (const name of found) assert.ok(allowed.has(name), `the main bundle imports ${name}, which is not on the allowed list`);
  for (const call of NETWORK) assert.ok(!call.test(src), `the main bundle contains ${call}`);
  // Exactly one dynamic import, and it loads the connectors file that sits next to the program.
  assert.deepEqual(src.match(/\bimport\s*\([^)]*\)/g), ["import(file.href)"]);
  assert.equal((src.match(/new URL\("\.\/connectors\.mjs", import\.meta\.url\)/g) ?? []).length, 1);
  // Only `pull`, and `run` when a pull is configured, reach that import.
  assert.deepEqual([...src.matchAll(/\(await connectors\(\)\)\.(\w+)/g)].map((m) => m[1]), ["pull"]);
});

test("the connectors file imports only fs and path and has a single place where a request is made, behind the host check", () => {
  const src = fs.readFileSync(BIN.replace("outrich.mjs", "connectors.mjs"), "utf8");
  assert.deepEqual([...new Set(imports(src))].sort(), ["fs", "path"]);
  assert.equal((src.match(/\bfetch\s*\(/g) ?? []).length, 1);
  for (const call of NETWORK.slice(1)) assert.ok(!call.test(src), `connectors contain ${call}`);
  const at = src.indexOf("fetch("), check = src.lastIndexOf("u.origin !== this.origin", at);
  assert.ok(check !== -1 && at - check < 600, "the origin check sits directly before the request");
  assert.match(src.slice(at, at + 120), /redirect: "error"/);
  assert.ok(!/process\.argv/.test(src), "connectors never read the command line: tokens come from the environment");
});

/* ---------------------------------------------------------------- block reader */

test("blocks: every block ends on a line end and the bytes are unchanged, at any chunk size", async () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} é中\u{1f600} ${"x".repeat(i % 97)}`).join("\n") + "\nlast line without newline";
  const bytes = enc.encode(text);
  for (const chunk of [1, 3, 7, 64, 1000, 1 << 20]) {
    const got = await collect(blocks(chunked(bytes, chunk), lineScanner(), 256, 4096));
    assert.deepEqual(joined(got), Buffer.from(bytes), `chunk ${chunk}`);
    for (const b of got.slice(0, -1)) assert.equal(b.bytes[b.bytes.length - 1], 10);
    assert.ok(got.every((b) => !b.raw));
    // No multibyte character is split: every block decodes without a replacement character.
    for (const b of got) assert.ok(!new TextDecoder("utf-8", { fatal: true }).decode(b.bytes).includes("�"));
  }
});

test("blocks: a UTF-8 BOM is dropped, even when it arrives one byte at a time", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\nb\n")]);
  for (const chunk of [1, 2, 100]) assert.equal(joined(await collect(blocks(chunked(bytes, chunk)))).toString(), "a\nb\n");
  assert.equal(joined(await collect(blocks(chunked(Buffer.from("ab"), 1)))).toString(), "ab");
  assert.deepEqual(await collect(blocks(chunked(Buffer.alloc(0), 1))), []);
});

test("blocks: a line over the cap is cut into raw pieces on character boundaries, then normal blocks resume", async () => {
  const long = "é".repeat(5000); // 10,000 bytes, every character two bytes
  const bytes = enc.encode(`first\n${long}\nafter one\nafter two\n`);
  const got = await collect(blocks(chunked(bytes, 333), lineScanner(), 256, 1024));
  assert.deepEqual(joined(got), Buffer.from(bytes));
  const raw = got.filter((b) => b.raw);
  assert.ok(raw.length > 3);
  assert.ok(Math.max(...got.map((b) => b.bytes.length)) <= 1024 + 333, "no block grows past the cap plus one chunk");
  assert.equal(raw.filter((b) => b.endsLine).length, 1, "exactly one piece closes the long line");
  for (const b of raw) assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(b.bytes));
  assert.equal(dec.decode(got[got.length - 1].bytes).endsWith("after two\n"), true);
  assert.equal(got[got.length - 1].raw, false);
});

test("blocks: CSV records with quoted newlines are never split", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `${i},"multi\nline ""quoted"" ${i}\r\nmore",5" nail,plain\r\n`);
  const bytes = enc.encode("id,note,size,x\r\n" + rows.join(""));
  for (const chunk of [1, 5, 50, 4096]) {
    const got = await collect(blocks(chunked(bytes, chunk), csvScanner(44), 200, 100000));
    assert.deepEqual(joined(got), Buffer.from(bytes));
    for (const b of got) {
      const text = dec.decode(b.bytes);
      assert.ok(!b.raw);
      assert.ok(/(?:^|\r\n)(?:\d+,|id,)/.test(text.slice(0, 20)), "a block starts at the start of a record");
      assert.equal(((text.match(/"/g) ?? []).length - (text.match(/5" nail/g) ?? []).length) % 2, 0, "quotes are balanced inside a block");
    }
  }
});

/* ---------------------------------------------------------------- scrub engine */

const CORPUS = [
  ...Array.from({ length: 1500 }, (_, i) => ticket(i).line),
  ...Array.from({ length: 300 }, (_, i) => ticket(i).record.body),
  "Server 2001:0db8:85a3:0000:0000:8a2e:0370:7334 and fe80::1ff:fe23:4567:890a answered at 10:00:00, also ::1 and 1:2:3:4:5:6:7:8.",
  "times 10:11:12:13:14:15:16 a:b:c:d:e:f:1:2 abcd::ef01 :: 1::2 notip:x:y:z:1:2:3:4",
  "VIN 1HGCM82633A004352 on file, also 1M8GDM9AXKP042788 and JH4KA7561PC008269, not A1B2C3D4E5F6G7H8I and 1HGCM82633A004353.",
  "x".repeat(16) + "1HGCM82633A004352" + " " + "1HGCM82633A004352".repeat(2) + "\n1HGCM82633A004352",
  "From: Dana Whitfield <dana.whitfield@acme.io>\nTo: Dr. Patel\nCall (415) 555-0142 or +44 20 7946 0958. SSN 123-45-6789, card 4111 1111 1111 1111.\nBest,\nDana",
  "My name is Wei Chen, DOB 1990-04-12, passport X1234567, IBAN GB82 WEST 1234 5698 7654 32, MAC 00:1B:44:11:3A:B7, 88 Canal St, Apt 4.",
  "password: hunter2!x api_key=Zx9KqLmN4pRsTuVw8yB2d5 Authorization: Bearer abc.def.ghi-12345678 postgres://u:s3cr3tpw@db.host/x",
  "", " ", "no personal data in this sentence at all", "ÀÉÎ Renée O'Brien-Smith met José Álvarez",
];
const OPTIONS = [{}, { mode: "mask" }, { mode: "hash", salt: "s" }, { mode: "synthetic" }, { mode: "remove" }, { nameSensitivity: "aggressive", numbered: false }, { nameSensitivity: "context" },
  { types: upstream.PII_TYPES.map((t) => t.type) }];

// The CLI copy of the engine has detector fixes the website copy does not have yet (see README). On data those
// fixes do not touch, the two must agree. Hash tokens for names are compared by position only: the CLI keys a
// name by its sorted words, so that "Lee Dana" and "Dana Lee" share a token.
test("the CLI engine copy agrees with the website engine on data the detector fixes do not touch", () => {
  const plain = (t) => t.replace(/\[NAME_[0-9a-f]{10}\]/g, "[NAME]");
  for (const opts of OPTIONS) {
    const mine = createScrubber({ ...opts, findings: false });
    for (const text of CORPUS) {
      const want = upstream.scrub(text, { ...opts, findings: false });
      mine.reset();
      const got = mine.scrub(text);
      assert.equal(plain(got.text), plain(want.text), JSON.stringify(opts) + " " + text.slice(0, 80));
      assert.deepEqual(got.counts, want.counts);
      assert.deepEqual(got.rules, want.rules);
    }
  }
});

test("reset() makes a reused scrubber behave like a new one, and a stateful scrubber still matches the website engine", () => {
  const a = createScrubber(), b = upstream.createScrubber();
  for (const text of CORPUS.slice(0, 200)) assert.equal(a.scrub(text).text, b.scrub(text).text);
  a.reset();
  assert.equal(a.scrub("a@x.com then b@x.com").text, "[EMAIL_1] then [EMAIL_2]");
});

/* ---------------------------------------------------------------- worker */

const scrubText = (work, fmt, text, extra = {}) => { const r = work({ kind: "scrub", fmt, bytes: enc.encode(text), raw: false, endsLine: true, ...extra }); return { text: dec.decode(r.out), tally: r.tally }; };

test("scrub is a pure function of the record: block boundaries do not change the output", () => {
  const work = createWorker({});
  const lines = Array.from({ length: 400 }, (_, i) => ticket(i).line + "\n");
  const whole = scrubText(work, "jsonl", lines.join(""));
  const parts = [lines.slice(0, 1), lines.slice(1, 150), lines.slice(150, 151), lines.slice(151)].map((p) => scrubText(work, "jsonl", p.join("")));
  assert.equal(parts.map((p) => p.text).join(""), whole.text);
  assert.equal(parts.reduce((n, p) => n + p.tally.replacements, 0), whole.tally.replacements);
  assert.equal(whole.tally.records, 400);
});

test("jsonl: values are scrubbed, structure and untouched records are kept byte for byte", () => {
  const work = createWorker({});
  const clean = '{"id" : 7,  "note":"nothing here", "n": 1.50}';
  const input = [
    JSON.stringify({ id: 1, name: "Dana Whitfield", email: "dana.whitfield@example.org", phone: 4155550142, body: "Hi,\nI am Dana. \"quoted\" \\ back\nThanks,\nDana", nested: { ip: "10.1.2.3", list: ["Wei Chen wrote", 5, null, true] } }),
    clean,
    '{"big":12345678901234567890,"email":"a@b.co"}',
    "not json, Dana Whitfield a@b.co",
    "",
  ].join("\r\n");
  const { text, tally } = scrubText(work, "jsonl", input);
  const out = text.split("\r\n");
  const first = JSON.parse(out[0]);
  assert.deepEqual(first, { id: 1, name: "[NAME_1]", email: "[EMAIL_1]", phone: "[PHONE_1]", body: "Hi,\nI am [NAME_1]. \"quoted\" \\ back\nThanks,\n[NAME_1]", nested: { ip: "[IP_1]", list: ["[NAME_2] wrote", 5, null, true] } });
  assert.equal(out[1], clean);
  assert.equal(out[2], '{"big":12345678901234567890,"email":"[EMAIL_1]"}', "a number too large to rewrite keeps its digits");
  assert.equal(out[3], "not json, [NAME_1] [EMAIL_1]");
  assert.equal(tally.invalidJson, 2);
  assert.equal(tally.records, 4);
  assert.ok(!text.includes("Dana") && !text.includes("example.org") && !text.includes("4155550142"));
});

test("jsonl: numbering restarts with each record, and hash mode gives the same token for the same value everywhere", () => {
  const two = '{"email":"a@x.com"}\n{"email":"b@x.com","other":"a@x.com"}\n';
  assert.equal(scrubText(createWorker({}), "jsonl", two).text, '{"email":"[EMAIL_1]"}\n{"email":"[EMAIL_1]","other":"[EMAIL_2]"}\n');
  const hashed = scrubText(createWorker({ mode: "hash", salt: "pepper" }), "jsonl", two).text.split("\n").map((l) => l && JSON.parse(l));
  assert.equal(hashed[0].email, hashed[1].other);
  assert.notEqual(hashed[0].email, hashed[1].email);
  assert.match(hashed[0].email, /^\[EMAIL_[0-9a-f]{10}\]$/);
  assert.notEqual(scrubText(createWorker({ mode: "hash", salt: "other" }), "jsonl", two).text.slice(0, 30), JSON.stringify(hashed[0]).slice(0, 30));
});

test("csv: cells are scrubbed with the header as context and rows are written back as valid CSV", () => {
  const work = createWorker({});
  const { text, tally } = scrubText(work, "csv", 'name,email,notes\r\nDana Whitfield,dana@example.org,"line one\nline two, call (415) 555-0142"\r\n"Chen, Wei",wei@example.org,"said ""hi"""\r\n', { header: ["name", "email", "notes"], delim: ",", first: true });
  assert.equal(text, '[NAME_1],[EMAIL_1],"line one\nline two, call [PHONE_1]"\n[NAME_1],[EMAIL_1],"said ""hi"""\n');
  assert.equal(tally.records, 2);
});

test("text: CRLF and invalid UTF-8 survive, and a raw piece of an oversized record is scrubbed as text", () => {
  const work = createWorker({});
  assert.equal(scrubText(work, "text", "mail a@x.com\r\n\r\nplain\nend b@x.com").text, "mail [EMAIL_1]\r\n\r\nplain\nend [EMAIL_1]");
  const bad = Buffer.concat([Buffer.from("ok a@x.com "), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(" tail\n")]);
  const r = work({ kind: "scrub", fmt: "text", bytes: new Uint8Array(bad), raw: false, endsLine: true });
  assert.equal(dec.decode(r.out), "ok [EMAIL_1] ��� tail\n");
  const piece = work({ kind: "scrub", fmt: "jsonl", bytes: enc.encode('{"a":"x@y.io","b":"'), raw: true, endsLine: false });
  assert.equal(dec.decode(piece.out), '{"a":"[EMAIL_1]","b":"');
  assert.equal(piece.tally.records, 0);
});
