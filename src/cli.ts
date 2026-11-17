// outrich: local data tools from Outrich Data. No runtime dependencies. Only `pull` (and `run` with a
// pull configured) uses the network, through a separate file; every other command is local.
import fs, { realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { audit, convert, manifest, plan, profile, scrub, secrets, UsageError, verify, VERSION, type Common, type Out } from "./commands.ts";
import { pull, run } from "./flow.ts";
import { loadPolicy } from "./fields.ts";
import { dropPartials } from "./files.ts";
import { createWorker, type Job } from "./work.ts";
import { PII_TYPES, type NameSensitivity, type PiiType, type ScrubMode } from "./lib/pii.ts";
import type { WorkerOptions } from "./records.ts";

// Exported for the tests, which import this bundle.
export { blocks, csvScanner, lineScanner } from "./blocks.ts";
export { createWorker } from "./work.ts";
export { walk } from "./files.ts";
export { keyRule } from "./fields.ts";
export { createScrubber } from "./lib/pii.ts";
export { buildManifest, describeFile, parseManifest, verifyManifest } from "./lib/manifest.ts";
export { convert as convertText } from "./lib/datatools.ts";
export { scanText } from "./lib/secrets.ts";

const HELP = `outrich ${VERSION}: local data tools from Outrich Data (https://outrichdata.com/tools)
Runs on your machine. Memory use does not grow with input size. Only "pull" uses the network.

Usage
  outrich run <config.json|dir|zip>          The whole flow: plan, scrub, residual check, secrets, profile, manifest, one report.
  outrich plan <file|dir|zip> -o policy.json Sample the data and write a field policy to review.
  outrich scrub <file|dir|zip> -o <out>      Redact personal data, by field and inside free text. Audit report with counts only.
  outrich audit <file|dir>                   Re-scan scrubbed output for what still looks like personal data. Exit 2 over the limit.
  outrich secrets <file|dir|zip>             Scan for leaked credentials. JSON lines on stdout, exit 1 when found.
  outrich manifest <dir|zip> -o manifest.json  SHA-256 every file and write a delivery manifest.
  outrich verify <dir|zip> <manifest.json>   Check a folder against a manifest. Exit 1 on any difference.
  outrich profile <file|dir|zip>             Records, size, approximate tokens, field coverage, personal data hits.
  outrich convert <in> -o <out>              CSV or TSV to JSONL, or JSONL to CSV or TSV.
  outrich pull <system> -o <dir>             BETA. Export from zendesk, github, jira, intercom, hubspot or slack with your own API token.

Formats
  .jsonl .ndjson .csv .tsv .txt .log .md .json (up to 64 MB) .mbox .eml, each optionally .gz, and .zip archives of them.

Common options
  --workers N    Worker threads (default: CPU cores minus one)
  --resume       scrub, manifest and pull: continue an interrupted run
  --json         Print the result as JSON on stdout
  --quiet        No progress or notes on stderr
  -h, --help     -v, --version

scrub options (also used by run)
  --policy FILE  Field policy from "outrich plan". Fields it does not list are decided by their names.
  --strict       Fail when the data has a field path the policy does not list.
  --no-audit     Skip the residual check that runs after scrubbing.
  --max-residual N  Residual EMAIL, PHONE, SSN or CARD values tolerated by the check (default 0). Also for audit.
  --mode M       label (default, [EMAIL_1]), mask, hash, synthetic or remove
  --salt S       Salt for hash and synthetic modes (or set OUTRICH_SALT)
  --names N      context, balanced (default) or aggressive
  --types LIST   Comma-separated types for the free-text detectors (default: all except URL): ${PII_TYPES.map((t) => t.type).join(",")}
  --report PATH  Where to write the audit report (default: <out>.scrub-report.json)

run options
  --allow-findings  Continue to the manifest even when the residual check or the secrets scan finds something.

pull options (tokens come from environment variables only, see the README)
  --target T     zendesk: subdomain. github: owner/repo or org. jira: site name.
  --base-url U   Use this API host instead of the vendor's default.
  --since DATE   zendesk, jira: start date.  --objects LIST  hubspot: object types. slack: channel IDs.

Detection is pattern, dictionary and field-name based. It reduces personal data but does not guarantee removal.
Sample the output before you rely on it.
`;

function fail(message: string): never { throw new UsageError(message); }

async function main(argv: string[]): Promise<Out | number> {
  const { values: v, positionals: [command, ...rest] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      output: { type: "string", short: "o" }, workers: { type: "string" }, resume: { type: "boolean" }, json: { type: "boolean" }, quiet: { type: "boolean" },
      mode: { type: "string" }, salt: { type: "string" }, names: { type: "string" }, types: { type: "string" }, report: { type: "string" },
      policy: { type: "string" }, strict: { type: "boolean" }, "no-audit": { type: "boolean" }, "max-residual": { type: "string" }, "allow-findings": { type: "boolean" },
      target: { type: "string" }, "base-url": { type: "string" }, since: { type: "string" }, objects: { type: "string" }, query: { type: "string" },
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    },
  });
  if (v.version) { process.stdout.write(VERSION + "\n"); return 0; }
  if (v.help || !command) { process.stdout.write(HELP); return v.help ? 0 : 2; }
  const workers = v.workers === undefined ? Math.max(1, availableParallelism() - 1) : Number(v.workers);
  if (!Number.isInteger(workers) || workers < 1 || workers > 512) fail("--workers takes a whole number from 1 to 512.");
  const c: Common = { workers, resume: !!v.resume, json: !!v.json, quiet: !!v.quiet };
  const need = (n: number, usage: string) => { if (rest.length !== n) fail(`Usage: outrich ${usage}`); };
  const maxResidual = v["max-residual"] === undefined ? undefined : Number(v["max-residual"]);
  if (maxResidual !== undefined && !(Number.isInteger(maxResidual) && maxResidual >= 0)) fail("--max-residual takes a whole number, 0 or more.");
  const policy = () => {
    if (!v.policy) return undefined;
    let text: string;
    try { text = fs.readFileSync(v.policy, "utf8"); } catch { return fail(`Cannot read ${v.policy}.`); }
    const p = loadPolicy(text);
    return { rules: p.policy, hash: p.hash, file: v.policy };
  };
  const scrubOptions = (): WorkerOptions => {
    const mode = v.mode ?? "label", names = v.names ?? "balanced";
    if (!["label", "mask", "hash", "synthetic", "remove"].includes(mode)) fail("--mode takes label, mask, hash, synthetic or remove.");
    if (!["context", "balanced", "aggressive"].includes(names)) fail("--names takes context, balanced or aggressive.");
    const known = new Set<string>(PII_TYPES.map((t) => t.type));
    const types = v.types?.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    for (const t of types ?? []) if (!known.has(t)) fail(`Unknown type ${t}. Known types: ${[...known].join(", ")}.`);
    return {
      mode: mode as ScrubMode, numbered: true, nameSensitivity: names as NameSensitivity, salt: v.salt ?? process.env.OUTRICH_SALT ?? "",
      types: (types as PiiType[] | undefined) ?? PII_TYPES.filter((t) => t.on).map((t) => t.type),
    };
  };

  switch (command) {
    case "scrub": need(1, "scrub <file|dir|zip> -o <out>"); return scrub(c, rest[0], { output: v.output, report: v.report, policy: policy(), strict: v.strict, audit: !v["no-audit"], maxResidual }, scrubOptions());
    case "plan": need(1, "plan <file|dir|zip> -o policy.json"); return plan(c, rest[0], v.output);
    case "audit": need(1, "audit <file|dir>"); return audit(c, rest[0], { policy: policy()?.rules, maxResidual });
    case "secrets": {
      need(1, "secrets <file|dir|zip>");
      const r = await secrets(c, rest[0], async (line) => { if (!process.stdout.write(line)) await new Promise((ok) => process.stdout.once("drain", ok)); });
      if (!c.quiet) process.stderr.write(r.text.join("\n") + "\n"); // stdout carries only the findings
      return r.code;
    }
    case "manifest": need(1, "manifest <dir|zip> -o manifest.json"); return manifest(c, rest[0], v.output);
    case "verify": need(2, "verify <dir|zip> <manifest.json>"); return verify(c, rest[0], rest[1]);
    case "profile": need(1, "profile <file|dir|zip>"); return profile(c, rest[0]);
    case "convert": need(1, "convert <in> -o <out>"); return convert(c, rest[0], v.output);
    case "pull": need(1, "pull <system> -o <dir>"); return pull(c, { system: rest[0], target: v.target, baseUrl: v["base-url"], since: v.since, query: v.query, objects: v.objects?.split(",").map((x) => x.trim()).filter(Boolean) }, v.output);
    case "run": need(1, "run <config.json|dir|zip>"); return run(c, rest[0], scrubOptions(), !!v["allow-findings"]);
    default: return fail(`Unknown command "${command}". Run outrich --help.`);
  }
}

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

if (!isMainThread && workerData?.outrichWorker) {
  const work = createWorker(workerData.options);
  parentPort!.on("message", (job: Job) => {
    try {
      const result = work(job, (progress) => parentPort!.postMessage({ progress }));
      parentPort!.postMessage({ result }, result.out ? [result.out.buffer as ArrayBuffer] : []);
    } catch (e) { parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) }); }
  });
} else if (isMainThread && process.argv[1] && same(realpathSync(process.argv[1]), fileURLToPath(import.meta.url))) {
  // Ctrl-C: no half-written file keeps a finished name.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { dropPartials(); process.stderr.write("\nInterrupted. Unfinished outputs were removed.\n"); process.exit(130); });
  // The reader closed the pipe (`outrich secrets dir | head`). Stop quietly; secrets had findings if it was still writing.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") throw e; dropPartials(); process.exit(process.argv[2] === "secrets" ? 1 : 0); });
  // OUTRICH_STATS=1 prints peak memory and wall time to stderr on exit. The benchmark and the large-file test read it.
  const t0 = Date.now();
  if (process.env.OUTRICH_STATS) process.on("exit", () => { process.stderr.write(JSON.stringify({ peakRssBytes: process.resourceUsage().maxRSS * 1024, wallMs: Date.now() - t0 }) + "\n"); });
  main(process.argv.slice(2)).then(
    (r) => {
      if (typeof r === "number") { process.exitCode = r; return; }
      process.stdout.write((process.argv.includes("--json") ? JSON.stringify(r.data) : r.text.join("\n")) + "\n");
      process.exitCode = r.code;
    },
    (e) => {
      dropPartials();
      process.stderr.write(`outrich: ${e instanceof Error ? e.message : e}\n`);
      process.exitCode = 2;
    },
  );
}
