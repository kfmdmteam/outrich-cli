// Secrets scanner: pattern rules with validators, masked previews and exports. Pure; tested by `npm test`.
// A finding never carries the secret itself, only a masked preview and its position.

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export type Finding = {
  ruleId: string;
  description: string;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  preview: string; // masked
  placeholder: boolean; // looks like a documented example or a placeholder
  entropy: number; // Shannon bits per character of the matched secret
};

/** Validator result: null drops the match, a severity overrides the rule default, undefined keeps it. */
type Verdict = Severity | null | undefined;
export type Rule = {
  id: string;
  description: string;
  severity: Severity;
  re: RegExp; // needs the g and d flags
  group?: number; // capture group holding the secret (default: whole match)
  literal?: boolean; // the match is a marker, not the secret (a PEM header), so it is shown as is
  validate?: (secret: string, m: RegExpExecArray, path: string) => Verdict;
};

/** Shannon entropy in bits per character. Random base64 is near 6, hex near 4, English words near 3. */
export function entropy(s: string): number {
  if (!s) return 0;
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let e = 0;
  for (const v of n.values()) e -= (v / s.length) * Math.log2(v / s.length);
  return e;
}

/** First 4 and last 2 characters only. Short secrets show less, so the preview never gives most of the value away. */
export function mask(s: string): string {
  if (s.length >= 12) return `${s.slice(0, 4)}${"*".repeat(Math.min(s.length - 6, 12))}${s.slice(-2)}`;
  return `${s.slice(0, s.length >= 6 ? 2 : 0)}${"*".repeat(6)}`;
}

const KNOWN_EXAMPLES = new Set(["AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY"]);
const PLACEHOLDER_PART = /example|sample|placeholder|change[_-]?me|dummy|fake|redacted|your[_-]|xxxx|\*{4}|<[^>]+>|1234567|insert|replace/i;
const PLACEHOLDER_WORD = /^(?:password|passwd|pass|secret|token|test|testing|todo|tbd|none|null|undefined|foo|bar|foobar|default|user|username|key|apikey|api_key)$/i;

/** Documented example keys and obvious placeholders. These are reported at low severity instead of hidden. */
export const isPlaceholder = (s: string) => KNOWN_EXAMPLES.has(s) || PLACEHOLDER_PART.test(s) || PLACEHOLDER_WORD.test(s) || /^(.)\1+$/.test(s);

const ENV_LIKE = /(^|\/)\.env[^/]*$|\.(env|ini|cfg|conf|config|properties|toml|ya?ml|tfvars|npmrc)$/i;
// A value that is a variable or call, not a literal: ${VAR}, $(cmd), {{ tpl }}, $VAR, fn(), os.environ[...], a path or a URL.
const REFERENCE = /\$\{|\$\(|\{\{|^\$[A-Za-z_]|[()[\]]|^<|^(?:process|os|env|import|require|config|settings|true|false|null|none|undefined)\b|^(?:\.{0,2}|~)\/|^https?:/i;
const minEntropy = (min: number) => (s: string): Verdict => (isPlaceholder(s) || entropy(s) >= min ? undefined : null);

function jwtHeader(token: string): Verdict {
  try {
    const head = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    return typeof JSON.parse(atob(head)).alg === "string" ? undefined : null;
  } catch { return null; }
}

// Order matters: when two matches overlap, the earlier rule wins, so specific rules come before generic ones.
export const RULES: Rule[] = [
  { id: "gcp-service-account-key", description: "Google Cloud service account private key", severity: "critical", literal: true, group: 1,
    re: /"private_key"\s*:\s*"(-----BEGIN (?:RSA )?PRIVATE KEY-----)/gd },
  { id: "private-key", description: "Private key block (PEM or PGP)", severity: "critical", literal: true,
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gd },
  { id: "aws-access-key-id", description: "AWS access key ID", severity: "high",
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/gd },
  { id: "aws-secret-access-key", description: "AWS secret access key", severity: "critical", group: 1,
    re: /(?:aws|secret)[^\n]{0,40}?[=:\s'"]([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gid,
    validate: (s) => (/^[0-9a-f]+$/i.test(s) ? null : minEntropy(4)(s)) },
  { id: "gcp-api-key", description: "Google Cloud API key", severity: "high",
    re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gd },
  { id: "azure-storage-key", description: "Azure storage or service bus key in a connection string", severity: "critical", group: 1,
    re: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{40,}={0,2})/gd },
  { id: "stripe-key", description: "Stripe secret, restricted or webhook key", severity: "critical",
    re: /\b(?:(?:sk|rk)_(live|test)_|whsec_)[0-9a-zA-Z]{16,}/gd,
    validate: (_s, m) => (m[1] === "test" ? "low" : undefined) },
  { id: "twilio-api-key", description: "Twilio API key SID", severity: "high",
    re: /\bSK[0-9a-f]{32}\b/gd },
  { id: "twilio-auth-token", description: "Twilio auth token", severity: "high", group: 1,
    re: /twilio[^\n]{0,40}?["'=:\s]([0-9a-f]{32})\b/gid, validate: minEntropy(3) },
  { id: "sendgrid-api-key", description: "SendGrid API key", severity: "critical",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gd },
  { id: "slack-token", description: "Slack token", severity: "critical",
    re: /\bxox[abeposr]-[A-Za-z0-9-]{10,}/gd },
  { id: "slack-webhook", description: "Slack incoming webhook URL", severity: "high",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/gd },
  { id: "github-token", description: "GitHub token", severity: "critical",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/gd },
  { id: "gitlab-token", description: "GitLab personal access token", severity: "critical",
    re: /\bglpat-[A-Za-z0-9_-]{20,}/gd },
  { id: "npm-token", description: "npm access token", severity: "critical",
    re: /\bnpm_[A-Za-z0-9]{36}\b/gd },
  { id: "npmrc-auth-token", description: "Registry auth token in .npmrc", severity: "high", group: 1,
    re: /_authToken\s*=\s*([^\s"']{8,})/gd, validate: (s) => (isPlaceholder(s) ? undefined : REFERENCE.test(s) ? null : undefined) },
  { id: "pypi-token", description: "PyPI upload token", severity: "critical",
    re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/gd },
  { id: "anthropic-api-key", description: "Anthropic-style API key", severity: "critical",
    re: /\bsk-ant-[A-Za-z0-9_-]{32,}/gd },
  { id: "openai-api-key", description: "OpenAI-style API key", severity: "critical",
    re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{32,})/gd, validate: minEntropy(3.5) },
  { id: "jwt", description: "JSON Web Token", severity: "medium",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gd, validate: jwtHeader },
  { id: "db-connection-string", description: "Database connection string with a password", severity: "critical", group: 1,
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:@/'"]*:([^\s@/'"]+)@[^\s'"]+/gid,
    validate: (s) => (isPlaceholder(s) ? undefined : REFERENCE.test(s) ? null : undefined) },
  { id: "db-password-parameter", description: "Database connection string with a Password parameter", severity: "high", group: 1,
    re: /\b(?:Server|Data Source|Host)=[^;\n]{1,200};[^\n]{0,300}?\b(?:Password|Pwd)=([^;\s"']{3,})/gid,
    validate: (s) => (isPlaceholder(s) ? undefined : REFERENCE.test(s) ? null : undefined) },
  { id: "basic-auth-url", description: "URL with an embedded username and password", severity: "high", group: 1,
    re: /\bhttps?:\/\/[^\s:@/'"]+:([^\s@/'"]+)@[\w.-]+/gd,
    validate: (s) => (isPlaceholder(s) ? undefined : REFERENCE.test(s) ? null : undefined) },
  { id: "env-secret-assignment", description: "Secret assigned to a variable or config key", severity: "medium", group: 3,
    re: /^[ \t]*(?:(?:export|const|let|var|set)[ \t]+)?["']?([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|access[_-]?key|secret[_-]?key|credentials?))["']?[ \t]*[=:][ \t]*(["']?)([^\s"'#,;]{6,})\2/gimd,
    validate(s, m, path) {
      if (isPlaceholder(s)) return undefined;
      if (REFERENCE.test(s)) return null;
      if (!m[2] && !ENV_LIKE.test(path)) return null; // in source code, only quoted literals count
      const e = entropy(s);
      return e >= 3.5 && s.length >= 16 ? "high" : e >= 3 ? "medium" : "low";
    } },
  { id: "generic-high-entropy", description: "High-entropy string next to a secret keyword", severity: "medium", group: 1,
    re: /(?:secret|token|passw(?:or)?d|api[_-]?key|credential|bearer)[^\n]{0,24}?["'\s=:]([A-Za-z0-9+/_-]{24,}={0,2})(?![A-Za-z0-9+/_=-])/gid,
    validate: (s) => (isPlaceholder(s) ? undefined : entropy(s) >= 4 && /\d/.test(s) && /[A-Za-z]/.test(s) ? undefined : null) },
];

const MAX_PER_FILE = 500; // ponytail: a file with more hits than this is a dump or a fixture; the cap keeps the UI usable.

/** Scans one text file. Returns findings sorted by position, with overlapping matches collapsed to the most specific rule. */
export function scanText(path: string, text: string): Finding[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (at: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const taken: [number, number][] = [];
  const out: (Finding & { at: number })[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      if (m[0] === "") { rule.re.lastIndex++; continue; }
      const start = m.index, end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      const secret = m[rule.group ?? 0] ?? m[0];
      const verdict = rule.validate ? rule.validate(secret, m, path) : undefined;
      if (verdict === null) continue;
      taken.push([start, end]);
      const placeholder = !rule.literal && isPlaceholder(secret);
      const at = m.indices?.[rule.group ?? 0]?.[0] ?? start;
      const line = lineOf(at);
      out.push({
        ruleId: rule.id, description: rule.description, severity: placeholder ? "low" : verdict ?? rule.severity,
        path, line: line + 1, column: at - lineStarts[line] + 1,
        preview: rule.literal ? secret : mask(secret), placeholder, entropy: Math.round(entropy(secret) * 100) / 100, at,
      });
      if (out.length >= MAX_PER_FILE) break;
    }
    if (out.length >= MAX_PER_FILE) break;
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...f }) => f);
}

// ---- Which files to read ------------------------------------------------------------------------

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|vendor|coverage|__pycache__|\.venv|venv|target|bower_components|\.idea|\.gradle)\//;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|packages\.lock\.json)$/;
const MINIFIED = /\.min\.(js|css|mjs)$|\.map$|\.bundle\.js$/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|apk|aab|ipa|dmg|iso|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|mkv|webm|wav|flac|ogg|sqlite3?|db|parquet|avro|orc|feather|docx?|xlsx?|pptx?)$/i;

/** Why a file is skipped, or "" when it should be scanned. */
export function skipReason(path: string, size: number): string {
  const p = path.replace(/\\/g, "/");
  if (IGNORED_DIRS.test(p)) return "ignored folder";
  if (LOCKFILES.test(p)) return "lockfile";
  if (MINIFIED.test(p)) return "minified or generated";
  if (BINARY_EXT.test(p)) return "binary type";
  if (size > MAX_FILE_BYTES) return "over 5 MB";
  return "";
}

/** A NUL byte in the first 8 KB marks a file as binary. */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// ---- Summary and exports ------------------------------------------------------------------------

const rank = (s: Severity) => SEVERITIES.indexOf(s);
export const sortFindings = (f: Finding[]) =>
  [...f].sort((a, b) => rank(a.severity) - rank(b.severity) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column));

export function summarize(findings: Finding[]) {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byRule: Record<string, number> = {};
  for (const f of findings) { bySeverity[f.severity]++; byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1; }
  return { total: findings.length, files: new Set(findings.map((f) => f.path)).size, bySeverity, byRule };
}

export const findingsToJson = (findings: Finding[], scannedFiles: number) =>
  JSON.stringify({ tool: "Outrich Data secrets scanner", scannedFiles, summary: summarize(findings), findings: sortFindings(findings) }, null, 2) + "\n";

// A leading = + - @ would run as a formula when the CSV is opened in a spreadsheet, so those cells get a quote prefix.
const csvCell = (v: string | number | boolean) => {
  const s = /^[=+\-@]/.test(String(v)) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const findingsToCsv = (findings: Finding[]) =>
  [["severity", "rule", "description", "path", "line", "column", "preview", "placeholder", "entropy"],
    ...sortFindings(findings).map((f) => [f.severity, f.ruleId, f.description, f.path, f.line, f.column, f.preview, f.placeholder, f.entropy])]
    .map((row) => row.map(csvCell).join(",")).join("\n") + "\n";

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = { critical: "error", high: "error", medium: "warning", low: "note" };

/** SARIF 2.1.0, the format code hosts and CI systems read for static analysis results. */
export function findingsToSarif(findings: Finding[]): string {
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: "Outrich Data secrets scanner",
        rules: RULES.map((r) => ({ id: r.id, name: r.id, shortDescription: { text: r.description }, defaultConfiguration: { level: SARIF_LEVEL[r.severity] }, properties: { severity: r.severity } })),
      } },
      results: sortFindings(findings).map((f) => ({
        ruleId: f.ruleId,
        ruleIndex: RULES.findIndex((r) => r.id === f.ruleId),
        level: SARIF_LEVEL[f.severity],
        message: { text: `${f.description}${f.placeholder ? " (looks like an example or placeholder)" : ""}: ${f.preview}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: encodeURI(f.path.replace(/\\/g, "/")) }, region: { startLine: f.line, startColumn: f.column } } }],
        properties: { severity: f.severity, placeholder: f.placeholder, entropy: f.entropy },
      })),
    }],
  }, null, 2) + "\n";
}
