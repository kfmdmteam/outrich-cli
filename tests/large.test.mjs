// End to end on a big file: memory stays flat and the output is right.
// Default size is about 200 MB. Set OUTRICH_E2E_MB=1024 (or more) for the full run, and OUTRICH_TMP to choose the disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { run, tmp } from "./helpers.mjs";
import { createWorker } from "../dist/outrich.mjs";
import { ticket, writeTickets } from "../scripts/gen.mjs";

const MB = Number(process.env.OUTRICH_E2E_MB ?? 200);
const RSS_LIMIT = 400 * 1024 * 1024;
const stats = (r) => JSON.parse(r.stderr.trim().split("\n").pop());

test(`scrub and manifest a ${MB} MB file with peak memory under 400 MB`, { timeout: 3_600_000 }, async (t) => {
  const dir = tmp(t), input = path.join(dir, "tickets.jsonl"), output = path.join(dir, "clean.jsonl");
  const made = await writeTickets(input, MB * 1024 * 1024);
  assert.ok(fs.statSync(input).size >= MB * 1024 * 1024);

  const env = { ...process.env, OUTRICH_STATS: "1" };
  // Memory is flat in input size but grows with the worker count (about 30 MB each), so the count is pinned here.
  const workers = String(Math.min(6, Math.max(1, os.availableParallelism() - 1)));
  const r = run(["scrub", input, "-o", output, "--workers", workers, "--quiet", "--json"], { env });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout), peak = stats(r).peakRssBytes;
  t.diagnostic(`scrub: ${(made.bytes / 1e6 / (report.durationMs / 1000)).toFixed(1)} MB/s, peak RSS ${(peak / 1048576).toFixed(0)} MB, ${report.options.workers} workers, ${made.records} records`);
  assert.ok(peak < RSS_LIMIT, `scrub peak RSS ${(peak / 1048576).toFixed(0)} MB`);
  assert.equal(report.totals.records, made.records);
  assert.equal(report.totals.jsonLinesScrubbedAsText, 0);
  assert.ok(report.counts.EMAIL >= made.records && report.counts.PHONE >= made.records && report.counts.NAME >= made.records);

  // Read the output as a stream. Every line keeps its place; sampled lines must equal the single-thread result.
  const work = createWorker({}), enc = new TextEncoder(), dec = new TextDecoder();
  const direct = (line) => dec.decode(work({ kind: "scrub", fmt: "jsonl", bytes: enc.encode(line), raw: false, endsLine: true }).out);
  const step = Math.max(1, Math.floor(made.records / 2000));
  let n = 0, sampled = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(output), crlfDelay: Infinity })) {
    if (n % step === 0 || n === made.records - 1) {
      const k = ticket(n);
      assert.equal(line, direct(k.line), `line ${n}`);
      assert.ok(!line.includes(k.email) && !line.includes(k.phone) && !line.includes(k.name), `line ${n} still holds a planted value`);
      assert.equal(JSON.parse(line).id, k.record.id);
      sampled++;
    } else if (n % 997 === 0) assert.ok(line.startsWith(`{"id":"TCK-${String(n).padStart(9, "0")}"`), `line ${n} is out of order`);
    n++;
  }
  assert.equal(n, made.records);
  assert.ok(sampled >= Math.min(2000, made.records));
  assert.ok(!fs.existsSync(output + ".partial"));

  const m = run(["manifest", dir, "-o", path.join(dir, "manifest.json"), "--workers", workers, "--quiet", "--json"], { env });
  assert.equal(m.status, 0, m.stderr);
  assert.ok(stats(m).peakRssBytes < RSS_LIMIT);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).files.find((f) => f.path === "tickets.jsonl").records, made.records);
  const v = run(["verify", dir, path.join(dir, "manifest.json"), "--workers", workers, "--quiet"], { env });
  assert.equal(v.status, 0, v.stdout);
  assert.ok(stats(v).peakRssBytes < RSS_LIMIT);
});
