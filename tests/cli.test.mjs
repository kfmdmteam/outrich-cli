import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { run, tmp, write, read } from "./helpers.mjs";
import { buildManifest, describeFile, convertText, createWorker } from "../dist/outrich.mjs";
import { ticket } from "../scripts/gen.mjs";

const tickets = (n, from = 0) => Array.from({ length: n }, (_, i) => ticket(from + i).line + "\n").join("");
const tree = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath, d.name)).replace(/\\/g, "/")).sort();

/* ---------------------------------------------------------------- scrub */

test("scrub: a folder is mirrored, gzip stays gzip, other files are skipped, and no value leaks into the report", (t) => {
  const dir = tmp(t), src = path.join(dir, "in"), out = path.join(dir, "out");
  const a = tickets(300), b = tickets(200, 5000);
  write(src, "a.jsonl", a);
  write(src, "deep/er/b.jsonl.gz", zlib.gzipSync(b));
  write(src, "deep/notes.txt", "Call Dana Whitfield on (415) 555-0142.\r\n");
  write(src, "people.csv", "name,email\nDana Whitfield,dana@example.org\n");
  write(src, "empty.jsonl", "");
  write(src, "image.png", Buffer.from([0x89, 0x50, 0, 1, 2]));
  const r = run(["scrub", src, "-o", out, "--workers", "3", "--quiet"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(out), ["a.jsonl", "deep/er/b.jsonl.gz", "deep/notes.txt", "empty.jsonl", "people.csv"]);
  assert.equal(read(out, "empty.jsonl"), "");
  assert.equal(read(out, "deep/notes.txt"), "Call [NAME_1] on [PHONE_1].\r\n");
  assert.equal(read(out, "people.csv"), "name,email\n[NAME_1],[EMAIL_1]\n");

  // Same output as the worker code called directly, in the same record order.
  const work = createWorker({});
  const direct = (text) => new TextDecoder().decode(work({ kind: "scrub", fmt: "jsonl", bytes: new TextEncoder().encode(text), raw: false, endsLine: true }).out);
  assert.equal(read(out, "a.jsonl"), direct(a));
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(out, "deep/er/b.jsonl.gz"))).toString(), direct(b));
  const lines = read(out, "a.jsonl").trimEnd().split("\n");
  lines.forEach((l, i) => { const o = JSON.parse(l), k = ticket(i); assert.equal(o.id, k.record.id); assert.ok(!l.includes(k.email) && !l.includes(k.phone) && !l.includes(k.name)); });

  const reportText = read(dir, "out.scrub-report.json"), report = JSON.parse(reportText);
  assert.equal(report.totals.files, 5);
  assert.equal(report.totals.records, 300 + 200 + 1 + 1);
  assert.ok(report.counts.EMAIL >= 500 && report.counts.NAME >= 500 && report.counts.PHONE >= 500);
  assert.deepEqual(report.skipped.map((s) => s.path), ["image.png"]);
  assert.equal(report.options.mode, "label");
  assert.ok(report.version && report.durationMs >= 0 && report.totals.bytesIn > 0);
  for (let i = 0; i < 300; i += 37) { const k = ticket(i); assert.ok(!reportText.includes(k.email) && !reportText.includes(k.phone) && !reportText.includes(k.name.split(" ")[1] + '"')); }
  assert.ok(!fs.existsSync(path.join(out, ".outrich-state.jsonl")), "state is removed after a clean run");
  assert.ok(!tree(dir).some((f) => f.endsWith(".partial")));
});

test("scrub: the output does not depend on the number of workers", (t) => {
  const dir = tmp(t), input = write(dir, "t.jsonl", tickets(6000)); // several blocks
  const outs = [1, 2, 5].map((w) => { const o = path.join(dir, `o${w}.jsonl`); assert.equal(run(["scrub", input, "-o", o, "--workers", String(w), "--quiet"]).status, 0); return read(o); });
  assert.equal(outs[0], outs[1]);
  assert.equal(outs[0], outs[2]);
  assert.equal(outs[0].split("\n").length, 6001);
  const salted = (salt) => { const o = path.join(dir, `h-${salt}.jsonl`); run(["scrub", input, "-o", o, "--mode", "hash", "--salt", salt, "--workers", "4", "--quiet"]); return read(o); };
  assert.equal(salted("a"), salted("a"));
  assert.notEqual(salted("a"), salted("b"));
  assert.ok(!read(dir, "h-a.jsonl.scrub-report.json").includes('"a"'), "the salt is not written to the report");
});

test("scrub: gzip in to plain out by file name, CRLF kept, BOM dropped, last line without a newline", (t) => {
  const dir = tmp(t);
  const input = write(dir, "in.jsonl.gz", zlib.gzipSync(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"e":"a@x.com"}\r\n{"e":"b@x.com"}')])));
  assert.equal(run(["scrub", input, "-o", path.join(dir, "out.jsonl"), "--quiet"]).status, 0);
  assert.equal(read(dir, "out.jsonl"), '{"e":"[EMAIL_1]"}\r\n{"e":"[EMAIL_1]"}');
});

test("scrub: a record over 4 MiB is scrubbed in pieces without growing memory, and is counted", (t) => {
  const dir = tmp(t);
  const big = `{"blob":"${"mail zed@example.org now. ".repeat(260_000)}"}\n`; // about 6.5 MB on one line
  const input = write(dir, "big.jsonl", `{"e":"a@x.com"}\n${big}{"e":"b@x.com"}\n`);
  const r = run(["scrub", input, "-o", path.join(dir, "out.jsonl"), "--quiet", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = read(dir, "out.jsonl"), report = JSON.parse(r.stdout);
  assert.ok(!out.includes("zed@example.org"));
  assert.ok(out.startsWith('{"e":"[EMAIL_1]"}\n{"blob":"mail [EMAIL_1] now.') && out.endsWith('"}\n{"e":"[EMAIL_1]"}\n'));
  assert.equal(report.totals.oversizedRecords, 1);
  assert.equal(report.totals.records, 3);
  // Just under the cap: still handled as JSON, in one piece.
  const under = write(dir, "under.jsonl", JSON.stringify({ blob: "mail zed@example.org now. ".repeat(150_000) }) + "\n"); // about 3.9 MB
  const u = run(["scrub", under, "-o", path.join(dir, "under.out.jsonl"), "--quiet", "--json"], { env: { ...process.env, OUTRICH_STATS: "1" } });
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual([JSON.parse(u.stdout).totals.oversizedRecords, JSON.parse(u.stdout).totals.jsonLinesScrubbedAsText, JSON.parse(u.stdout).counts.EMAIL], [0, 0, 150_000]);
  assert.equal(JSON.parse(read(dir, "under.out.jsonl")).blob, "mail [EMAIL_1] now. ".repeat(150_000));
});

test("scrub: path mistakes are refused with exit code 2 and nothing is written", (t) => {
  const dir = tmp(t), src = path.join(dir, "in");
  const file = write(src, "a.jsonl", tickets(3));
  assert.equal(run(["scrub", file, "-o", file, "--quiet"]).status, 2);
  assert.equal(run(["scrub", src, "-o", src, "--quiet"]).status, 2);
  assert.equal(run(["scrub", src, "-o", dir, "--quiet"]).status, 2, "input inside output");
  assert.equal(run(["scrub", path.join(dir, "missing"), "-o", path.join(dir, "x"), "--quiet"]).status, 2);
  assert.equal(run(["scrub", src, "--quiet"]).status, 2);
  assert.equal(run(["scrub", file, "-o", path.join(dir, "o.jsonl"), "--mode", "nope"]).status, 2);
  assert.equal(read(file), tickets(3));
  // Unwritable output: the parent of the output path is a file.
  const r = run(["scrub", file, "-o", path.join(file, "sub", "o.jsonl"), "--quiet"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^outrich: /);
  assert.deepEqual(tree(dir), ["in/a.jsonl"]);
});

test("scrub: an output folder inside the input folder is left out of the scan", (t) => {
  const dir = tmp(t), src = path.join(dir, "in");
  write(src, "a.jsonl", tickets(5));
  const args = ["scrub", src, "-o", path.join(src, "clean"), "--report", path.join(dir, "r.json"), "--quiet"];
  assert.equal(run(args).status, 0);
  assert.equal(run(args).status, 0);
  assert.deepEqual(tree(src), ["a.jsonl", "clean/a.jsonl"]);
});

test("scrub --resume: finished files are kept, the rest are done, and changed options are refused", (t) => {
  const dir = tmp(t), src = path.join(dir, "in"), out = path.join(dir, "out");
  for (const n of ["a", "b", "c"]) write(src, `${n}.jsonl`, tickets(50, n.charCodeAt(0) * 100));
  assert.equal(run(["scrub", src, "-o", out, "--quiet"]).status, 0);
  const full = JSON.parse(read(dir, "out.scrub-report.json"));
  // Rebuild the state an interrupted run would have left: a and b recorded, c not finished.
  const entry = (n) => { const st = fs.statSync(path.join(src, `${n}.jsonl`)), f = full.files.find((x) => x.path === `${n}.jsonl`); return JSON.stringify({ ...f, size: st.size, mtimeMs: st.mtimeMs }); };
  fs.rmSync(path.join(out, "c.jsonl"));
  fs.writeFileSync(path.join(out, "c.jsonl.partial"), "half");
  fs.writeFileSync(path.join(out, "a.jsonl"), "MARKER\n"); // proves a.jsonl is not redone
  const head = stateHeader(src, dir);
  fs.writeFileSync(path.join(out, ".outrich-state.jsonl"), [head, entry("a"), entry("b"), '{"path":"c.jsonl","torn'].join("\n"));
  const r = run(["scrub", src, "-o", out, "--resume", "--quiet", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.totals.filesResumed, 2);
  assert.equal(report.totals.files, 3);
  assert.deepEqual(report.counts, full.counts, "resumed files still count in the report");
  assert.equal(read(out, "a.jsonl"), "MARKER\n");
  assert.equal(JSON.parse(read(out, "c.jsonl").split("\n")[0]).id, ticket(9900).record.id);
  assert.ok(!fs.existsSync(path.join(out, "c.jsonl.partial")) && !fs.existsSync(path.join(out, ".outrich-state.jsonl")));
  // Different options: refuse to resume.
  fs.writeFileSync(path.join(out, ".outrich-state.jsonl"), head + "\n");
  const refused = run(["scrub", src, "-o", out, "--resume", "--mode", "mask", "--quiet"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /different options/);
});

// The first line of the state file for a default-options run of `scrub src -o out`, produced by the tool itself:
// a run where one input cannot be read fails, and a failed run keeps its state file.
function stateHeader(src, dir) {
  const probeOut = path.join(dir, "probe-out");
  fs.mkdirSync(path.join(probeOut, "b.jsonl"), { recursive: true }); // b.jsonl cannot be written: its output path is a folder
  const r = run(["scrub", src, "-o", probeOut, "--quiet"]);
  assert.equal(r.status, 2);
  const head = JSON.parse(read(probeOut, ".outrich-state.jsonl").split("\n")[0]);
  const parts = JSON.parse(head.key);
  assert.equal(parts[0], "scrub");
  fs.rmSync(probeOut, { recursive: true });
  return JSON.stringify(head);
}

test("links: a link that leaves the input folder is not followed", (t) => {
  const dir = tmp(t), src = path.join(dir, "in"), outside = path.join(dir, "outside");
  write(src, "a.txt", "mail a@x.com\n");
  write(outside, "secret.txt", "mail leak@x.com\n");
  try { fs.symlinkSync(outside, path.join(src, "link"), "junction"); } catch { return t.skip("cannot create links here"); }
  const r = run(["scrub", src, "-o", path.join(dir, "out"), "--quiet", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(path.join(dir, "out")), ["a.txt"]);
  assert.match(JSON.parse(r.stdout).skipped.find((s) => s.path === "link").reason, /outside the input folder/);
  const m = run(["manifest", src, "-o", path.join(dir, "m.json"), "--quiet", "--json"]);
  assert.equal(JSON.parse(m.stdout).totals.files, 1);
});

/* ---------------------------------------------------------------- manifest and verify */

test("manifest: the file is byte for byte what the website's buildManifest produces", async (t) => {
  const dir = tmp(t), src = path.join(dir, "data");
  const files = {
    "a.jsonl": tickets(200), "sub/b.csv": "x,y\r\n1,2\r\n3,4", "sub/deep/c.bin": Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251)),
    "empty.txt": "", "Zed.TXT": "one\ntwo\n", "notes.md": "# hi\n", "gz/d.jsonl.gz": zlib.gzipSync("{}\n{}\n"), "spaces and ü.log": "line\n",
  };
  for (const [rel, data] of Object.entries(files)) write(src, rel, data);
  const out = path.join(dir, "manifest.json");
  const r = run(["manifest", src, "-o", out, "--workers", "3", "--quiet"]);
  assert.equal(r.status, 0, r.stderr);
  const written = read(out), parsed = JSON.parse(written);
  // The website path: describeFile() on each file as a Blob, then buildManifest(), serialized as its download button does.
  const described = [];
  for (const [rel, data] of Object.entries(files)) described.push(await describeFile(rel, new Blob([data])));
  const expected = await buildManifest(described, parsed.created);
  assert.equal(written, JSON.stringify(expected, null, 2) + "\n");
  assert.equal(parsed.manifestHash, expected.manifestHash);
  assert.equal(parsed.files.find((f) => f.path === "a.jsonl").records, 200);
  assert.equal(parsed.files.find((f) => f.path === "sub/b.csv").records, 3);
  assert.equal(parsed.files.find((f) => f.path === "empty.txt").records, 0);
  assert.ok(!("records" in parsed.files.find((f) => f.path === "sub/deep/c.bin")));
  assert.match(r.stdout, new RegExp(`Manifest hash: ${expected.manifestHash}`));
  // A manifest written inside the folder does not list itself.
  assert.equal(run(["manifest", src, "-o", path.join(src, "manifest.json"), "--quiet"]).status, 0);
  assert.equal(JSON.parse(read(src, "manifest.json")).manifestHash, expected.manifestHash);
  assert.equal(run(["verify", src, path.join(src, "manifest.json"), "--quiet"]).status, 0);
});

test("verify: match, mismatch, size, missing and extra are told apart, and any difference exits 1", (t) => {
  const dir = tmp(t), src = path.join(dir, "data"), m = path.join(dir, "manifest.json");
  for (const n of ["same", "edit", "grow", "gone"]) write(src, `${n}.txt`, `content of ${n}\n`);
  assert.equal(run(["manifest", src, "-o", m, "--quiet"]).status, 0);
  const ok = run(["verify", src, m, "--quiet"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /match 4 {2}mismatch 0 {2}size 0 {2}missing 0 {2}extra 0/);
  assert.match(ok.stdout, /^PASS/m);
  fs.writeFileSync(path.join(src, "edit.txt"), "content of EDIT\n");
  fs.appendFileSync(path.join(src, "grow.txt"), "more\n");
  fs.rmSync(path.join(src, "gone.txt"));
  write(src, "new/extra.txt", "x");
  const bad = run(["verify", src, m, "--quiet", "--json"]);
  assert.equal(bad.status, 1);
  const v = JSON.parse(bad.stdout);
  assert.deepEqual(v.counts, { match: 1, mismatch: 1, missing: 1, extra: 1, size: 1 });
  assert.deepEqual(Object.fromEntries(v.differences.map((d) => [d.path, d.status])), { "edit.txt": "mismatch", "grow.txt": "size", "gone.txt": "missing", "new/extra.txt": "extra" });
  // Only an extra file: still a difference.
  fs.writeFileSync(path.join(src, "edit.txt"), "content of edit\n"); fs.writeFileSync(path.join(src, "grow.txt"), "content of grow\n"); write(src, "gone.txt", "content of gone\n");
  assert.equal(run(["verify", src, m, "--quiet"]).status, 1);
  fs.rmSync(path.join(src, "new"), { recursive: true });
  assert.equal(run(["verify", src, m, "--quiet"]).status, 0);
  // A manifest edited after it was made is refused.
  fs.writeFileSync(m, read(m).replace(/"size": \d+/, '"size": 1'));
  const edited = run(["verify", src, m, "--quiet"]);
  assert.equal(edited.status, 2);
  assert.match(edited.stderr, /does not match its file list/);
});

/* ---------------------------------------------------------------- secrets, profile, convert */

test("secrets: findings are JSON lines with correct line numbers across blocks, previews are masked, exit code is 1", (t) => {
  const dir = tmp(t);
  const key = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
  const filler = "nothing to see on this line of ordinary text\n".repeat(9000); // more than one block
  write(dir, "logs/app.log", `${filler}stripe = ${key}\n${filler}-----BEGIN RSA PRIVATE KEY-----\n`);
  write(dir, "clean.txt", "hello\n");
  write(dir, "node_modules/x/index.js", `const k = "${key}";\n`);
  write(dir, "data.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)]));
  const r = run(["secrets", dir, "--workers", "2"]);
  assert.equal(r.status, 1);
  const found = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(found.map((f) => [f.file, f.line, f.type]), [["logs/app.log", 9001, "stripe-key"], ["logs/app.log", 18002, "private-key"]]);
  assert.equal(found[0].severity, "critical");
  assert.ok(!r.stdout.includes(key) && found[0].preview.startsWith("sk_l") && found[0].preview.includes("*"));
  assert.match(r.stderr, /2 possible secrets in 1 of 2 files/);
  const none = run(["secrets", path.join(dir, "clean.txt"), "--quiet"]);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");
});

test("profile: records, tokens, field coverage and personal data counts", (t) => {
  const dir = tmp(t);
  const input = write(dir, "t.jsonl", tickets(1000) + '{"id":"x","extra":1}\n');
  const p = JSON.parse(run(["profile", input, "--quiet", "--json"]).stdout);
  assert.equal(p.totals.records, 1001);
  assert.equal(p.totals.bytes, fs.statSync(input).size);
  assert.ok(Math.abs(p.totals.approxTokens - fs.statSync(input).size / 4) < fs.statSync(input).size * 0.02);
  assert.equal(p.files[0].fields.id, 1001);
  assert.equal(p.files[0].fields.customer, 1000);
  assert.equal(p.files[0].fields.extra, 1);
  assert.ok(p.totals.personalData.EMAIL >= 1000 && p.totals.personalData.NAME >= 2000);
  const csv = write(dir, "c.csv", "a,b\n1,\n2,x\n");
  const c = JSON.parse(run(["profile", csv, "--quiet", "--json"]).stdout);
  assert.deepEqual([c.totals.records, c.files[0].fields], [2, { a: 2, b: 1 }]);
  assert.match(run(["profile", input, "--quiet"]).stdout, /customer\s+99\.9%/);
});

test("convert: CSV to JSONL and back gives what the website converter gives", (t) => {
  const dir = tmp(t);
  const csv = "id,name,note,\r\n" + Array.from({ length: 3000 }, (_, i) => `${i},"Name, ${i}","line one\nline ""two"" ${i}",x\r\n`).join("") + "\r\nshort\r\n";
  const input = write(dir, "in.csv", csv);
  assert.equal(run(["convert", input, "-o", path.join(dir, "out.jsonl"), "--workers", "3", "--quiet"]).status, 0);
  assert.equal(read(dir, "out.jsonl"), convertText("in.csv", csv, "jsonl"));
  const jsonl = '{"a":1,"b":"x,y"}\n{"b":"two\\nlines","c":{"d":[1,2]},"a":null}\n\n' + tickets(2000) + '{"late":"key"}\n';
  const j = write(dir, "in.jsonl", jsonl);
  assert.equal(run(["convert", j, "-o", path.join(dir, "out.csv"), "--workers", "3", "--quiet"]).status, 0);
  assert.equal(read(dir, "out.csv"), convertText("in.jsonl", jsonl, "csv"));
  assert.equal(run(["convert", j, "-o", path.join(dir, "out.tsv.gz"), "--quiet"]).status, 0);
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, "out.tsv.gz"))).toString(), convertText("in.jsonl", jsonl, "tsv"));
  // A bad line is left out, reported, and turns the exit code to 1.
  const bad = write(dir, "bad.jsonl", '{"a":1}\nnot json\n{"a":2}\n');
  const r = run(["convert", bad, "-o", path.join(dir, "bad.csv"), "--quiet"]);
  assert.equal(r.status, 1);
  assert.equal(read(dir, "bad.csv"), "a\n1\n2\n");
  assert.equal(run(["convert", input, "-o", path.join(dir, "x.csv"), "--quiet"]).status, 2);
});

test("usage: help, version, unknown command", () => {
  assert.equal(run(["--help"]).status, 0);
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(run(["frobnicate"]).status, 2);
  assert.equal(run([]).status, 2);
});

test("interrupt: a run that is stopped part way leaves no file under the finished name", async (t) => {
  const { spawn } = await import("node:child_process");
  const { BIN } = await import("./helpers.mjs");
  const dir = tmp(t), input = write(dir, "t.jsonl", tickets(60_000)), out = path.join(dir, "out.jsonl");
  const child = spawn(process.execPath, [BIN, "scrub", input, "-o", out, "--workers", "1", "--quiet"], { stdio: "ignore" });
  const exited = new Promise((ok) => child.on("exit", ok));
  for (let i = 0; i < 400 && !fs.existsSync(out + ".partial"); i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(fs.existsSync(out + ".partial"), "the run writes to a .partial file first");
  assert.ok(!fs.existsSync(out));
  child.kill("SIGINT"); // on Windows this ends the process outright, which is the harsher case
  await exited;
  assert.ok(!fs.existsSync(out), "no finished-looking output after an interrupted run");
  assert.ok(!fs.existsSync(out + ".scrub-report.json"));
  if (process.platform !== "win32") assert.ok(!fs.existsSync(out + ".partial"), "Ctrl-C removes the unfinished file");
  // Running again from the start succeeds and replaces any leftover.
  assert.equal(run(["scrub", input, "-o", out, "--quiet"]).status, 0);
  assert.equal(read(out).split("\n").length, 60_001);
  assert.ok(!fs.existsSync(out + ".partial"));
});
