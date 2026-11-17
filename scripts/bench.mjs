// npm run bench: generates synthetic support tickets, runs the built CLI on them and writes BENCH.md
// with what was measured on this machine. Nothing in BENCH.md is estimated except the one line marked as such.
// OUTRICH_BENCH_MB sets the data size (default 1024). OUTRICH_TMP sets where the data goes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { property, writeTickets } from "./gen.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = path.join(root, "dist", "outrich.mjs");
const MB = Number(process.env.OUTRICH_BENCH_MB ?? 1024);
const dir = fs.mkdtempSync(path.join(process.env.OUTRICH_TMP ?? os.tmpdir(), "outrich-bench-"));
const data = path.join(dir, "data"), clean = path.join(dir, "clean");
fs.mkdirSync(data);

function run(name, args, bytes, okCodes = [0]) {
  const r = spawnSync(process.execPath, [bin, ...args, "--quiet"], { encoding: "utf8", env: { ...process.env, OUTRICH_STATS: "1" }, maxBuffer: 1 << 30 });
  if (!okCodes.includes(r.status)) throw new Error(`${name} exited ${r.status}: ${r.stderr}`);
  const s = JSON.parse(r.stderr.trim().split("\n").pop());
  const row = { name, bytes, seconds: s.wallMs / 1000, rate: bytes / 1e6 / (s.wallMs / 1000), rss: s.peakRssBytes / 1048576, stdout: r.stdout };
  console.log(`${name}: ${row.seconds.toFixed(1)} s, ${row.rate.toFixed(1)} MB/s, peak RSS ${row.rss.toFixed(0)} MB`);
  return row;
}

try {
  console.log(`Generating ${MB} MB of synthetic tickets in ${dir} ...`);
  const big = await writeTickets(path.join(data, "tickets.jsonl"), MB * 1e6);
  const small = await writeTickets(path.join(dir, "one-core.jsonl"), Math.min(MB, 64) * 1e6);
  const cores = os.availableParallelism(), workers = Math.max(1, cores - 1);

  fs.mkdirSync(path.join(dir, "props"));
  const props = await writeTickets(path.join(dir, "props", "inspections.jsonl"), Math.min(MB, 256) * 1e6, 0, property);

  // The residual check is switched off for the scrub rows so that scrub and audit are timed separately.
  const scrub = run(`scrub (${workers} workers)`, ["scrub", data, "-o", clean, "--no-audit", "--json"], big.bytes);
  const report = JSON.parse(scrub.stdout);
  const one = run("scrub (1 worker)", ["scrub", path.join(dir, "one-core.jsonl"), "-o", path.join(dir, "one-core.out.jsonl"), "--workers", "1", "--no-audit"], small.bytes);
  const audit = run("audit of the scrubbed tickets", ["audit", clean], fs.statSync(path.join(clean, "tickets.jsonl")).size);
  const plan = run("plan (reads 4 MB per file)", ["plan", path.join(dir, "props"), "-o", path.join(dir, "policy.json")], props.bytes);
  const structured = run("scrub with a field policy (property records)", ["scrub", path.join(dir, "props"), "-o", path.join(dir, "props-clean"), "--policy", path.join(dir, "policy.json"), "--no-audit", "--json"], props.bytes);
  const sreport = JSON.parse(structured.stdout);
  const manifest = run("manifest", ["manifest", data, "-o", path.join(dir, "manifest.json")], big.bytes);
  const verify = run("verify", ["verify", data, path.join(dir, "manifest.json")], big.bytes);
  const secrets = run(`secrets (${workers} workers)`, ["secrets", data], big.bytes, [1]);
  const found = secrets.stdout.trim().split("\n").filter(Boolean).length;
  const rows = [scrub, one, audit, plan, structured, manifest, verify, secrets];

  const hours = (r) => (1e12 / 1e6 / r.rate / 3600).toFixed(1);
  const md = `# Benchmark

Measured by \`npm run bench\` on ${new Date().toISOString().slice(0, 10)}. Every figure in the tables was measured on the machine below.
Run it on your own hardware before you plan around these numbers.

## Machine

| | |
|---|---|
| CPU | ${os.cpus()[0].model.trim()} |
| Logical cores | ${cores} |
| Memory | ${(os.totalmem() / 2 ** 30).toFixed(1)} GB |
| OS | ${os.type()} ${os.release()} (${os.arch()}) |
| Node | ${process.version} |
| outrich | ${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version} |

The machine was a desktop in normal use, with other programs running. No effort was made to quiet it.
Logical cores count hyper-threads, so the number of physical cores is lower.

## Data

Synthetic support tickets as JSON Lines, made by \`scripts/gen.mjs\`: ${big.records.toLocaleString("en-US")} records in one file of ${(big.bytes / 1e6).toFixed(0)} MB
(${Math.round(big.bytes / big.records)} bytes per record on average). Each ticket has a customer name, email and phone in their own fields,
an agent name, and a free-text body that sometimes repeats the email and phone and signs off with a first name.
The scrub run made ${report.totals.replacements.toLocaleString("en-US")} replacements, ${(report.totals.replacements / big.records).toFixed(1)} per record. That is dense: text with less personal data in it scrubs faster.
The field-policy row uses a second synthetic set, property inspection records: ${props.records.toLocaleString("en-US")} records, ${(props.bytes / 1e6).toFixed(0)} MB, ${Math.round(props.bytes / props.records)} bytes each,
with names, addresses and phones in their own fields. That run made ${sreport.totals.replacements.toLocaleString("en-US")} replacements, ${(sreport.totals.replacements / props.records).toFixed(1)} per record.
All names, addresses and numbers are made up.

## Results

MB means 1,000,000 bytes. Time is wall time for the whole process, start to exit. Peak RSS is the peak resident memory of the process, all threads included.

| Command | Input | Time | Throughput | Peak RSS |
|---|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${(r.bytes / 1e6).toFixed(0)} MB | ${r.seconds.toFixed(1)} s | ${r.rate.toFixed(1)} MB/s | ${r.rss.toFixed(0)} MB |`).join("\n")}

The scrub rows ran with the residual check off (--no-audit) so that scrub and audit are timed separately. By default scrub runs the audit when it finishes, and the two times add up.
Plan reads only the first 4 MB of each file, so its time does not grow with file size and its throughput figure means little.
Scrub per worker: ${one.rate.toFixed(1)} MB/s with one worker, ${(scrub.rate / workers).toFixed(1)} MB/s per worker with ${workers} workers.
The secrets run reported ${found.toLocaleString("en-US")} findings (the generator plants a fake key in one ticket out of 250).
Manifest and verify read a file that had just been written, so it was partly in the operating system's file cache. On cold data they are limited by the disk.
A single file is hashed on one core, because SHA-256 cannot be split. A folder of many files is hashed on all workers.

## Extrapolation (not measured)

At the rates measured above, 1 TB (1,000,000 MB) of data like this would take about ${hours(scrub)} hours to scrub, ${hours(audit)} more hours for the residual check, ${hours(manifest)} hours to manifest,
${hours(verify)} hours to verify and ${hours(secrets)} hours to scan for secrets on this machine. This is arithmetic, not a measurement: nothing here was run at 1 TB,
and a real terabyte will not sit in the file cache.
`;
  fs.writeFileSync(path.join(root, "BENCH.md"), md);
  console.log("Wrote BENCH.md");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
