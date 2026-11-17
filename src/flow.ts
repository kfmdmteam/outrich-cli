// `pull` and `run`: the commands that chain the others. The network code is not in this file.
// It lives in dist/connectors.mjs and is loaded here, on demand, only for a pull.
import fs from "node:fs";
import path from "node:path";
import { audit, manifest, num, plan, profile, scrub, secrets, UsageError, VERSION, type Common, type Out } from "./commands.ts";
import { loadPolicy } from "./fields.ts";
import { writeAtomic } from "./files.ts";
import { formatBytes } from "./lib/manifest.ts";
import type { WorkerOptions } from "./records.ts";

export type PullConfig = { system: string; target?: string; baseUrl?: string; since?: string; query?: string; objects?: string[] };
type Connectors = { pull(c: PullConfig, dir: string, resume: boolean): Promise<{ system: string; host: string; requests: number; files: { file: string; records: number }[] }>; systems: string[] };

async function connectors(): Promise<Connectors> {
  const file = new URL("./connectors.mjs", import.meta.url);
  if (!fs.existsSync(file)) throw new Error("dist/connectors.mjs is missing. The connectors are a separate file; build it with npm run build.");
  return import(file.href);
}

export async function pull(c: Common, cfg: PullConfig, output?: string): Promise<Out> {
  if (!output) throw new UsageError("pull needs an output folder: outrich pull <system> -o <dir>");
  const dir = path.resolve(output);
  if (!c.quiet) process.stderr.write(`Pulling from ${cfg.system}. This command uses the network; it contacts one host only.\n`);
  const r = await (await connectors()).pull(cfg, dir, c.resume);
  const records = r.files.reduce((n, f) => n + f.records, 0);
  return { code: 0, data: { ...r, output: dir, records }, text: [`Pulled ${num(records)} records from ${r.system} (${r.host}) in ${num(r.requests)} requests.`, ...r.files.map((f) => `  ${f.file.padEnd(40)} ${num(f.records).padStart(10)}`), `Output: ${dir}`] };
}

export type RunConfig = { input?: string; pull?: PullConfig; output?: string; policy?: string; allowFindings?: boolean };

/** pull (optional), plan, scrub with the policy, residual check, secrets scan, profile, manifest. Writes outrich-report.json and REPORT.md. */
export async function run(c: Common, arg: string, options: WorkerOptions, allow: boolean): Promise<Out> {
  let cfg: RunConfig;
  if (/\.json$/i.test(arg) && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    try { cfg = JSON.parse(fs.readFileSync(arg, "utf8")); } catch { throw new UsageError(`${arg} is not valid JSON.`); }
    const base = path.dirname(path.resolve(arg));
    for (const k of ["input", "output", "policy"] as const) if (cfg[k]) cfg[k] = path.resolve(base, cfg[k]!);
  } else cfg = { input: path.resolve(arg) };
  if (!cfg.input && !cfg.pull) throw new UsageError('The run config needs "input" (a folder, file or .zip) or "pull" (a system to export from).');
  const out = path.resolve(cfg.output ?? `${(cfg.input ?? cfg.pull!.system).replace(/\.zip$/i, "")}-outrich`);
  allow ||= !!cfg.allowFindings;
  const quiet: Common = { ...c, json: false }, started = Date.now(), steps: { step: string; status: string; seconds: number }[] = [];
  const data: Record<string, any> = { tool: "outrich", version: VERSION, command: "run", started: new Date(started).toISOString(), output: out };
  const step = async (name: string, fn: () => Promise<Out>): Promise<Out> => {
    const t0 = Date.now();
    if (!c.quiet) process.stderr.write(`[run] ${name}\n`);
    const r = await fn();
    steps.push({ step: name, status: r.code === 0 ? "ok" : `exit ${r.code}`, seconds: (Date.now() - t0) / 1000 });
    return r;
  };
  let failed = "", code = 0;
  const done = async (): Promise<Out> => {
    data.finished = new Date().toISOString(); data.durationMs = Date.now() - started; data.steps = steps;
    data.status = failed ? `stopped: ${failed}` : "complete";
    await writeAtomic(path.join(out, "outrich-report.json"), JSON.stringify(data, null, 2) + "\n");
    await writeAtomic(path.join(out, "REPORT.md"), reportMarkdown(data));
    return { code, data, text: [failed ? `Run stopped: ${failed}.${allow ? "" : " Fix the cause, or pass --allow-findings to continue past findings."}` : "Run complete.",
      ...steps.map((s) => `  ${s.step.padEnd(10)} ${s.status.padEnd(8)} ${s.seconds.toFixed(1)}s`),
      ...(data.manifest ? [`Manifest hash: ${data.manifest.manifestHash}`] : []), `Clean data: ${path.join(out, "clean")}`, `Report: ${path.join(out, "REPORT.md")} and outrich-report.json`] };
  };

  let input = cfg.input!;
  if (cfg.pull) {
    input = path.join(out, "export");
    data.pull = (await step("pull", () => pull(quiet, cfg.pull!, input))).data;
  }
  data.input = input;
  let policyFile = cfg.policy;
  if (!policyFile) {
    policyFile = path.join(out, "policy.json");
    const p = await step("plan", () => plan(quiet, input, policyFile));
    data.plan = { policy: policyFile, sampledRecords: p.data.sampledRecords, fields: p.data.fields.length };
  }
  const loaded = loadPolicy(fs.readFileSync(policyFile, "utf8"));
  data.policy = { file: policyFile, sha256: loaded.hash };
  const clean = path.join(out, "clean");
  const s = await step("scrub", () => scrub(quiet, input, { output: clean, report: path.join(out, "scrub-report.json"), policy: { rules: loaded.policy, hash: loaded.hash, file: policyFile! } }, options));
  const { files: _files, rules: _rules, note: _note, audit: residual, ...summary } = s.data;
  data.scrub = summary; data.audit = residual ?? null;
  if (s.code !== 0) {
    code = s.code;
    const auditFailed = residual && !residual.ok;
    if (!auditFailed || !allow) { failed = auditFailed ? "the residual check found personal data in the output" : "scrub could not process every file"; return done(); }
  }
  const findings: string[] = [];
  const sec = await step("secrets", () => secrets(quiet, clean, (line) => { findings.push(line); }));
  fs.writeFileSync(path.join(out, "secrets.jsonl"), findings.join(""));
  data.secrets = sec.data;
  if (sec.code !== 0) { code = Math.max(code, sec.code); if (!allow || sec.code === 2) { failed = sec.code === 2 ? "the secrets scan could not read every file" : "the secrets scan found possible credentials in the output"; return done(); } }
  data.profile = (await step("profile", () => profile(quiet, clean))).data.totals;
  const m = await step("manifest", () => manifest(quiet, clean, path.join(out, "manifest.json")));
  if (m.code !== 0) { code = 2; failed = "the manifest could not be built"; return done(); }
  data.manifest = { file: path.join(out, "manifest.json"), manifestHash: m.data.manifestHash, totals: m.data.totals, created: m.data.created };
  return done();
}

const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;

/** The report a seller can hand to counsel and to the escrow. Counts and shapes only: no removed value appears in it. */
function reportMarkdown(d: Record<string, any>): string {
  const s = d.scrub, a = d.audit, lines = [
    "# Data preparation report", "",
    `- Status: ${d.status}`, `- Produced by: outrich ${d.version}, on ${d.finished}`, `- Source: ${d.pull ? `${d.pull.system} (${d.pull.host}), ${num(d.pull.records)} records exported in ${num(d.pull.requests)} requests` : d.input}`,
    `- Clean data: ${path.join(d.output, "clean")}`, ...(d.manifest ? [`- Manifest hash (SHA-256): \`${d.manifest.manifestHash}\``] : []), "",
    "This report was produced on the data owner's machine. It holds counts and the shapes of values, never the values themselves.",
    "Detection is pattern, dictionary and field-name based. It reduces personal data and does not guarantee removal. A person should sample the clean data before it is shared.", "",
  ];
  if (d.pull) lines.push("## What was exported", "", row(["File", "Records"]), row(["---", "---"]), ...d.pull.files.map((f: any) => row([f.file, num(f.records)])), "");
  if (s) {
    lines.push("## What was removed", "", `- Files: ${num(s.totals.files)}`, `- Records: ${num(s.totals.records)}`, `- Size in: ${formatBytes(s.totals.bytesIn)}. Size out: ${formatBytes(s.totals.bytesOut)}`,
      `- Replacements: ${num(s.totals.replacements)}`, `- Mode: ${s.options.mode}`, `- Policy: ${d.policy.file} (SHA-256 \`${d.policy.sha256}\`)`, "",
      row(["Type", "Replacements"]), row(["---", "---"]), ...Object.entries(s.counts as Record<string, number>).sort((x, y) => y[1] - x[1]).map(([t, n]) => row([t, num(n)])), "",
      "By field. TEXT counts values in which the detectors removed something from free text.", "", row(["Field", "Removed"]), row(["---", "---"]),
      ...Object.entries(s.byField as Record<string, Record<string, number>>).slice(0, 200).map(([p, k]) => row([p, Object.entries(k).map(([t, n]) => `${t} ${num(n)}`).join(", ")])), "");
    if (s.skipped?.length) lines.push(`Files not processed and not copied to the clean folder: ${num(s.skipped.length)}. They are listed in scrub-report.json.`, "");
    if (s.errors?.length) lines.push("Files that failed:", ...s.errors.map((e: any) => `- ${e.path}: ${e.error}`), "");
  }
  if (a) lines.push("## Residual check", "", `The clean data was scanned again after scrubbing: ${num(a.records)} records. Result: ${a.ok ? "PASS" : "FAIL"} (limit ${a.maxResidual} each for EMAIL, PHONE, SSN and CARD).`, "",
    ...(a.residual.length ? [row(["Field", "Type", "Count", "Shape of what was found"]), row(["---", "---", "---", "---"]), ...a.residual.slice(0, 200).map((r: any) => row([r.path, r.type, num(r.count), r.samples.join("; ")])), "",
      "Rows other than EMAIL, PHONE, SSN and CARD do not fail the check. They are candidates for a person to review: a detector or a field name suggests personal data may remain."] : ["Nothing that looks like personal data was found."]), "");
  if (d.secrets) lines.push("## Credentials scan", "", d.secrets.findings ? `${num(d.secrets.findings)} possible credentials in ${num(d.secrets.filesWithFindings)} files. Masked previews are in secrets.jsonl.` : `No credentials found in ${num(d.secrets.files)} files.`, "");
  if (d.profile) lines.push("## Clean data", "", `- Files: ${num(d.profile.files)}`, `- Records: ${num(d.profile.records)}`, `- Size: ${formatBytes(d.profile.bytes)}`, `- Approximate tokens: ${num(d.profile.approxTokens)}`, "");
  if (d.manifest) lines.push("## Manifest", "", `- File: ${d.manifest.file}`, `- Files listed: ${num(d.manifest.totals.files)}, ${num(d.manifest.totals.bytes)} bytes`, `- Manifest hash: \`${d.manifest.manifestHash}\``, "",
    "Both parties compare the manifest hash. The buyer checks a delivery with `outrich verify <folder> manifest.json` or with the delivery tools on outrichdata.com.", "");
  lines.push("## Steps", "", row(["Step", "Result", "Seconds"]), row(["---", "---", "---"]), ...d.steps.map((x: any) => row([x.step, x.status, x.seconds.toFixed(1)])), "");
  return lines.join("\n");
}
