// Pattern-based personal-data scrubber. Pure and dependency-free: runs in the browser (nothing is
// uploaded), in a Web Worker, and under `npm test`.
// ponytail: patterns, validators (Luhn, mod-97, check digits) and a name dictionary, not a trained
// model. It is reliable on structured identifiers and on names that are in the dictionary or next to
// a cue. Unusual free-floating names still need the custom-terms list or a human review.
import { AMBIGUOUS, GIVEN, NOT_NAMES, SURNAMES } from "./pii-names.ts";

export const ENGINE_VERSION = "2.0.0";

export type PiiType =
  | "CUSTOM" | "SECRET" | "EMAIL" | "URL" | "CARD" | "IBAN" | "CRYPTO" | "TAX_ID" | "SSN" | "NATIONAL_ID" | "BANK"
  | "PASSPORT" | "LICENSE" | "DOB" | "IP" | "MAC" | "VIN" | "PHONE" | "ADDRESS" | "NAME" | "ID";

export const PII_TYPES: { type: PiiType; label: string; hint: string; on: boolean }[] = [
  { type: "EMAIL", label: "Email addresses", hint: "dana@acme.com", on: true },
  { type: "PHONE", label: "Phone numbers", hint: "(415) 555-0142, +44 20 7946 0958", on: true },
  { type: "NAME", label: "Names", hint: "From: Dana Lee, Dr. Patel, Will Turner", on: true },
  { type: "ADDRESS", label: "Street addresses", hint: "88 Canal St, PO Box 12", on: true },
  { type: "DOB", label: "Dates of birth", hint: "Only next to a cue such as DOB or born on", on: true },
  { type: "SSN", label: "US Social Security numbers", hint: "123-45-6789", on: true },
  { type: "TAX_ID", label: "US tax IDs", hint: "EIN and ITIN", on: true },
  { type: "NATIONAL_ID", label: "UK and Canadian IDs", hint: "NI number, SIN", on: true },
  { type: "PASSPORT", label: "Passport numbers", hint: "Only next to the word passport", on: true },
  { type: "LICENSE", label: "Driver's license numbers", hint: "Only next to a license cue", on: true },
  { type: "CARD", label: "Payment card numbers", hint: "Luhn-checked", on: true },
  { type: "IBAN", label: "IBANs", hint: "Checksum-verified", on: true },
  { type: "BANK", label: "Bank account and routing numbers", hint: "Only next to a cue; routing numbers are checksum-verified", on: true },
  { type: "CRYPTO", label: "Crypto wallet addresses", hint: "Bitcoin and Ethereum", on: true },
  { type: "SECRET", label: "API keys and passwords", hint: "sk_live_…, AKIA…, JWTs, connection strings", on: true },
  { type: "IP", label: "IP addresses", hint: "IPv4 and IPv6", on: true },
  { type: "MAC", label: "MAC addresses", hint: "00:1B:44:11:3A:B7", on: true },
  { type: "VIN", label: "Vehicle identification numbers", hint: "Check-digit verified", on: true },
  { type: "ID", label: "Account and customer IDs", hint: "Only next to a cue such as customer ID or order #", on: true },
  { type: "URL", label: "URLs", hint: "Links often carry IDs", on: false },
];

// When two matches start at the same place, the type listed first wins.
const PRIORITY = Object.fromEntries(
  ["CUSTOM", "SECRET", "EMAIL", "URL", "CARD", "IBAN", "CRYPTO", "TAX_ID", "SSN", "NATIONAL_ID", "BANK", "PASSPORT", "LICENSE", "DOB", "IP", "MAC", "VIN", "PHONE", "ADDRESS", "NAME", "ID"].map((t, i) => [t, i]),
) as Record<PiiType, number>;

/* ------------------------------------------------------------------ validators */

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum over the digits in `s`. */
export function luhnValid(s: string): boolean {
  const d = digitsOf(s);
  if (d.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 && (n *= 2) > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

const CARD_BRANDS = /^(?:4\d{12}(?:\d{3}){0,2}|(?:5[1-5]|2[2-7])\d{14}|3[47]\d{13}|3(?:0[0-5]|[689])\d{11,16}|35\d{14,17}|6(?:011|5\d\d|4[4-9]\d|2\d\d)\d{12,15}|(?:50|5[6-9]|6\d)\d{10,17})$/;
/** 13 to 19 digits, a known card-brand prefix and length, and a passing Luhn checksum. */
export function cardValid(s: string): boolean {
  const d = digitsOf(s);
  return d.length >= 13 && d.length <= 19 && CARD_BRANDS.test(d) && !/^(\d)\1+$/.test(d) && luhnValid(d);
}

const IBAN_LEN: Record<string, number> = Object.fromEntries(
  "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 CH21 CR22 CY28 CZ24 DE22 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IS26 IT27 JO30 KW30 KZ20 LB28 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 SE24 SI19 SK24 SM27 TN24 TR26 UA29 VG24 XK20"
    .split(" ").map((x) => [x.slice(0, 2), +x.slice(2)]),
);
/** IBAN: known country, exact country length, mod-97 checksum equal to 1. */
export function ibanValid(s: string): boolean {
  const c = s.replace(/\s/g, "").toUpperCase();
  if (IBAN_LEN[c.slice(0, 2)] !== c.length || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(c)) return false;
  const moved = c.slice(4) + c.slice(0, 4);
  let r = 0;
  for (let i = 0; i < moved.length; i++) {
    const code = moved.charCodeAt(i);
    r = code >= 65 ? (r * 100 + code - 55) % 97 : (r * 10 + code - 48) % 97;
  }
  return r === 1;
}
// A candidate may run into the next word, so accept the leading part that is a valid IBAN.
const ibanPrefix = (v: string) => {
  const need = IBAN_LEN[v.slice(0, 2)];
  if (!need) return false;
  let seen = 0, end = 0;
  while (end < v.length && seen < need) if (v[end++] !== " ") seen++;
  return seen === need && ibanValid(v.slice(0, end)) ? end : false;
};

const VIN_VALUES = "0123456789.ABCDEFGH..JKLMN.P.R..STUVWXYZ";
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
/** VIN: 17 characters without I, O or Q, and a correct check digit in position 9. */
export function vinValid(s: string): boolean {
  const v = s.toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (VIN_VALUES.indexOf(v[i]) % 10) * VIN_WEIGHTS[i];
  return "0123456789X"[sum % 11] === v[8];
}

/** US bank routing number: 9 digits, a Federal Reserve prefix, and the 3-7-1 checksum. */
export function abaValid(s: string): boolean {
  if (!/^\d{9}$/.test(s)) return false;
  const p = +s.slice(0, 2);
  if (!((p <= 12) || (p >= 21 && p <= 32) || (p >= 61 && p <= 72) || p === 80)) return false;
  const d = [...s].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + d[2] + d[5] + d[8]) % 10 === 0;
}

const EIN_BAD = new Set(["00", "07", "08", "09", "17", "18", "19", "28", "29", "49", "69", "70", "78", "79", "89", "96", "97"]);
/** US EIN: NN-NNNNNNN with a prefix the IRS has issued. */
export const einValid = (s: string) => /^\d{2}-\d{7}$/.test(s) && !EIN_BAD.has(s.slice(0, 2));
/** US SSN: area is not 000, 666 or 9xx; group is not 00; serial is not 0000. */
export function ssnValid(s: string): boolean {
  const d = digitsOf(s);
  return d.length === 9 && !/^(?:000|666|9)/.test(d) && d.slice(3, 5) !== "00" && d.slice(5) !== "0000";
}
/** US ITIN: starts with 9 and has a group in the ranges the IRS assigns. */
export const itinValid = (s: string) => /^9\d{2}(?:5\d|6[0-5]|7\d|8[0-8]|9[0-24-9])\d{4}$/.test(digitsOf(s)) && digitsOf(s).length === 9;
const sinValid = (s: string) => digitsOf(s).length === 9 && luhnValid(s);

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function bech32Valid(addr: string): boolean {
  const a = addr.toLowerCase(), pos = a.lastIndexOf("1");
  if (pos < 1 || pos + 7 > a.length) return false;
  let chk = 1;
  const step = (v: number) => {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
  };
  for (let i = 0; i < pos; i++) step(a.charCodeAt(i) >> 5);
  step(0);
  for (let i = 0; i < pos; i++) step(a.charCodeAt(i) & 31);
  for (let i = pos + 1; i < a.length; i++) {
    const v = BECH32.indexOf(a[i]);
    if (v < 0) return false;
    step(v);
  }
  return chk === 1 || chk === 0x2bc830a3;
}

function ipv6Valid(v: string): boolean {
  const dbl = v.indexOf("::");
  if (dbl !== v.lastIndexOf("::")) return false;
  const [head, tail] = dbl === -1 ? [v, ""] : [v.slice(0, dbl), v.slice(dbl + 2)];
  const groups = [...(head ? head.split(":") : []), ...(tail ? tail.split(":") : [])];
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  return dbl === -1 ? groups.length === 8 : groups.length >= 2 && groups.length <= 7 && (groups.length >= 3 || /\d/.test(v));
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}
// Random-looking: long enough, mixes digits or letter case, and clears the entropy threshold.
const looksRandom = (v: string, minLen: number, minBits: number) =>
  v.length >= minLen && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v))) && shannonEntropy(v) >= minBits;

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex characters. Fast and stable. NOT cryptographic:
 *  short or guessable values can be recovered by trying candidates, salt or not. */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}
/** Stable salted hash token for a whole value (used by the `hash` column policy). */
export const hashValue = (value: string, salt = "") => fnv1a64(`${salt}\u0000${value}`);

/* ------------------------------------------------------------------ detectors */

type Ok = (value: string, text: string, start: number, m: RegExpExecArray) => boolean | number;
// `g`: capture group holding the value, which must sit `tail` characters before the end of the match.
type Detector = { type: PiiType; rule: string | ((v: string, text: string, start: number) => string); re: RegExp; g?: number; tail?: number; ok?: Ok };

const CAP = "A-ZÀ-ÖØ-Þ", LOW = "a-zà-öø-ÿ", LET = "A-Za-zÀ-ÖØ-öø-ÿ";
const NAME = `(?:[${CAP}][${LOW}]+(?:[${CAP}][${LOW}]+)?(?:['’-][${CAP}]?[${LOW}]+)*|[${CAP}]['’][${CAP}][${LOW}]+)`;
const STREET = "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Circle|Cir|Square|Sq";

const secretRule = (v: string) =>
  v.startsWith("-----") ? "private-key" : v.startsWith("https://hooks.slack") ? "slack-webhook" : /^(?:[spr]k_|whsec_)/.test(v) ? "stripe-key"
  : /^A[KS]IA/.test(v) ? "aws-access-key" : v.startsWith("AIza") ? "google-api-key" : v.startsWith("xox") ? "slack-token"
  : /^(?:gh[pousr]_|github_pat_)/.test(v) ? "github-token" : v.startsWith("eyJ") ? "jwt" : "api-key";
const schemeBefore = (text: string, start: number) => /([A-Za-z][A-Za-z0-9+.-]*)$/.exec(text.slice(Math.max(0, start - 24), start))?.[1].toLowerCase() ?? "";
const trimUrl = (v: string) => v.replace(/[.,;:!?]+$/, "").length;

const DETECTORS: Detector[] = [
  { type: "SECRET", rule: secretRule, re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]{0,40}PRIVATE KEY-----|\b(?:https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/-]{20,200}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,200}|whsec_[A-Za-z0-9]{16,200}|sk-[A-Za-z0-9_-]{20,300}|A[KS]IA[0-9A-Z]{16}(?![0-9A-Z])|gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|glpat-[A-Za-z0-9_-]{20,100}|xox[abeprs]-[A-Za-z0-9-]{10,250}|AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])|SG\.[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{16,100}|npm_[A-Za-z0-9]{36}|eyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000})/g },
  // user:password@host in any URL: basic auth and database connection strings. Only the password is removed.
  { type: "SECRET", rule: (_v, text, start) => (/^https?$/.test(schemeBefore(text, text.lastIndexOf("://", start))) ? "basic-auth-url" : "connection-string"),
    re: /:\/\/([^\s:@\/]{0,64}):([^\s@\/]{1,128})@(?=[\w.[-])/g, g: 2, tail: 1 },
  { type: "SECRET", rule: "url-token", re: /[?&](?:access_token|refresh_token|id_token|token|api_?key|key|secret|client_secret|signature|sig|password|passwd|pwd|auth|session|sessionid|sid|code|jwt)=([^&\s#"'<>]{8,2000})/gi, g: 1 },
  { type: "URL", rule: "url", re: /\b(?:https?|ftp):\/\/[^\s<>"')\]]+/g, ok: trimUrl },
  { type: "CARD", rule: "card-luhn", re: /\b\d(?:[ -]?\d){12,18}\b/g, ok: cardValid },
  { type: "IBAN", rule: "iban-mod97", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, ok: ibanPrefix },
  { type: "CRYPTO", rule: "eth-address", re: /\b0x[a-fA-F0-9]{40}\b/g },
  { type: "CRYPTO", rule: "btc-bech32", re: /\bbc1[02-9ac-hj-np-z]{11,71}\b/g, ok: bech32Valid },
  { type: "CRYPTO", rule: "btc-base58", re: /\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, ok: (v) => /\d/.test(v.slice(1)) && /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { type: "TAX_ID", rule: "itin", re: /(?<![\d-])9\d{2}-\d{2}-\d{4}(?![\d-])/g, ok: itinValid },
  { type: "SSN", rule: "ssn", re: /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g, ok: ssnValid },
  { type: "NATIONAL_ID", rule: "uk-nino", re: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z](?: ?\d{2}){3} ?[A-D]\b/g },
  { type: "IP", rule: "ipv4", re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g,
    ok: (v, text, start) => v.split(".").every((o) => +o <= 255) && !/\b(?:v|ver|version|build|release)\.?[ \t]*$/i.test(text.slice(Math.max(0, start - 12), start)) },
  { type: "IP", rule: "ipv6", re: /(?<![\w:.])(?=[0-9A-Fa-f]{0,4}:)[0-9A-Fa-f:]{6,39}(?![\w:])/g, ok: ipv6Valid },
  { type: "MAC", rule: "mac", re: /\b[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b(?![:-][0-9A-Fa-f])/g, ok: (v) => !/^(?:00|ff)(?:[:-](?:00|ff)){5}$/i.test(v) },
  { type: "VIN", rule: "vin-check-digit", re: /\b[A-HJ-NPR-Z0-9]{17}\b/g, ok: (v) => /\d{4}$/.test(v) && (v.match(/[A-Z]/g)?.length ?? 0) >= 2 && vinValid(v) },
  { type: "PHONE", rule: "phone-e164", re: /(?<![\w+])\+[1-9][\d ().-]{6,22}\d(?![\w-]|\.\d)/g, ok: (v) => {
      if (/[ .()-]{3}|\.\.|--/.test(v) || (v.match(/\(/g)?.length ?? 0) !== (v.match(/\)/g)?.length ?? 0)) return false;
      let end = v.length; // a following number can be swallowed: drop trailing groups until it is a legal length
      while (digitsOf(v.slice(0, end)).length > 15 && end > 0) end = v.slice(0, end).search(/[ .-]\d+$/);
      const n = digitsOf(v.slice(0, Math.max(end, 0))).length;
      return n >= 8 && n <= 15 ? end : false;
    } },
  { type: "PHONE", rule: "phone-nanp", re: /(?<![\w.+-])(?:1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-])\d{3}[ .-]\d{4}(?: ?(?:x|ext\.?) ?\d{1,5})?(?![\w-]|\.\d)/g,
    ok: (v) => { const d = digitsOf(v.replace(/ ?(?:x|ext\.?) ?\d+$/i, "")); return v.includes("(") || (d.length === 11 ? d[1] : d[0]) >= "2"; } },
  { type: "PHONE", rule: "phone-national", re: /(?<![\w.+-])\(?0\d{1,4}\)?(?:[ .-]\d{2,8}){1,4}(?![\w-]|\.\d)/g,
    ok: (v) => { const d = digitsOf(v); return d.length >= 10 && d.length <= 11 && d[1] !== "0" && !/^\(?0\d\)?[ .-]\d{1,2}[ .-](?:19|20)\d{2}/.test(v); } },
  { type: "ADDRESS", rule: "street-address", re: new RegExp(`\\b\\d{1,6}[A-Za-z]?[ \\t]+(?:[A-Z][A-Za-z0-9.'-]*[ \\t]+){1,4}(?:${STREET})\\b\\.?(?:,?[ \\t]+(?:Apt|Apartment|Suite|Ste|Unit|Floor|Fl)\\.?[ \\t]*#?[A-Za-z0-9-]{1,6}\\b)?`, "g") },
  { type: "ADDRESS", rule: "po-box", re: /\bP\.? ?O\.? ?Box +\d{1,7}\b/gi },
  { type: "NAME", rule: "name-title", re: new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof)\\.?[ \\t]+(${NAME}(?:[ \\t]+${NAME}){0,2})`, "g"), g: 1 },
  { type: "NAME", rule: "name-cue", re: new RegExp(`(?:^|\\n)[ \\t]*(?:From|To|Cc|Bcc|Name|Attn|Attention|Customer|Agent|Caller|Rep|Author|Reviewer|Assignee|Contact|Patient|Client|Sender|Recipient|Employee|Owner|Requester|Reporter|Signed)[ \\t]*:[ \\t]*["']?(${NAME}(?:[ \\t]+${NAME}){0,2})`, "g"), g: 1 },
  { type: "NAME", rule: "name-field", re: new RegExp(`"(?:[A-Za-z]+_)?(?:[Nn]ame|[Ff]ull[Nn]ame|[Ff]irst[Nn]ame|[Ll]ast[Nn]ame)"[ \\t]*:[ \\t]*"(${NAME}(?:[ \\t]+${NAME}){0,2})"`, "g"), g: 1, tail: 1 },
  { type: "NAME", rule: "name-greeting", re: new RegExp(`\\b(?:(?:Dear|Hi|Hello|Hey|Regards|Sincerely|Cheers|Thanks|regards|thanks),?\\s+|(?:Best|Yours|Warmly|Kind regards|Best regards|Best wishes|Thank you|Many thanks|Yours truly|Yours sincerely),[ \\t]*\\r?\\n[ \\t]*)(${NAME}(?:[ \\t]+${NAME})?)\\b`, "g"), g: 1 },
];

/* ------------------------------------------------------------------ cue detectors
   One pass finds every cue word; a sticky pattern then reads the value that follows it. */

type Cue = { type: PiiType; rule: string | ((v: string, m: RegExpExecArray) => string); atoms: string[]; re: RegExp; ok?: (v: string, m: RegExpExecArray, text: string) => boolean };

const N = String.raw`(?:[ \t]+(?:number|num|no\.?|nbr|#|id))?`;
const S = String.raw`["']?[ \t]*(?:[:=#-]|(?:is|was)\b)?[ \t]*["']?#?`;
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = String.raw`\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[ \t]+${MONTH}\.?,?[ \t]+\d{4}|${MONTH}\.?[ \t]+\d{1,2}(?:st|nd|rd|th)?,?[ \t]+\d{4}`;
const cue = (src: string) => new RegExp(src, "iyd");
const PLACEHOLDER = /^(?:\*+|x+|\.+|<.*|\$\{.*|\{\{.*|%.*%|\[.*|null|none|nil|undefined|true|false|yes|no|required|optional|redacted|hidden|empty|blank|string|invalid|incorrect|expired|missing)$/i;
const CODE_EXPR = /^[A-Za-z_]\w*(?:\.\w+)*[[(]|^[A-Za-z_]\w*\.\w+$|^(?:process\.env|os\.environ|getenv|env)\b/;
const ID_WORDS = "account|acct|customer|client|member(?:ship)?|policy|case|order|ticket|invoice|employee|patient|user|subscriber|claim|booking|reservation|confirmation|ref(?:erence)?|tracking|loyalty|record|mrn|badge|student|transaction|txn";

const CUES: Cue[] = [
  { type: "SECRET", rule: "password-assignment", atoms: ["pass", "pwd"],
    re: cue(String.raw`(?:pass(?:word|wd|phrase|code)|pwd)([A-Za-z0-9_-]{0,24})["']?(?:[ \t]*([:=])|[ \t]+is\b)[ \t]*(?:"([^"\n]{4,200})"|'([^'\n]{4,200})'|([^\s"',;]{4,200}))`),
    ok: (v, m) => !PLACEHOLDER.test(v) && (m[5] === undefined || (!CODE_EXPR.test(v) && (m[2] && !m[1] ? true : looksRandom(v, 6, 2.5)))) },
  { type: "SECRET", rule: (v, m) => (v.length === 40 && /access|aws/i.test(m[0].slice(0, -40)) ? "aws-secret-key" : m[2] ? "secret-assignment" : "high-entropy-string"),
    atoms: ["secret", "token", "api", "access", "refresh", "auth", "session", "bearer", "private", "client", "credential", "signing", "encryption"],
    re: cue(String.raw`(?:secret|(?:access|refresh|auth|session|api|bearer)[_ -]?(?:token|key|secret)|token|apikey|private[_ -]?key|client[_ -]?secret|credentials?|signing[_ -]?key|encryption[_ -]?key)([A-Za-z0-9_-]{0,24})["']?(?:[ \t]*([:=])[ \t]*|[ \t]+)["']?([A-Za-z0-9_\-+/=.~!@#$%^*]{8,300})`),
    ok: (v, m) => !PLACEHOLDER.test(v) && !CODE_EXPR.test(v) && (m[2] ? looksRandom(v, 8, 3) : looksRandom(v, 20, 3.5)) },
  { type: "SECRET", rule: "bearer-token", atoms: ["auth", "bearer"],
    re: cue(String.raw`(?:authorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)|bearer)[ \t]+([A-Za-z0-9._~+/-]{8,2000}=*)`), ok: (v) => looksRandom(v, 8, 2.5) },
  { type: "PASSPORT", rule: "passport-in-context", atoms: ["pass"], re: cue(String.raw`passport${N}${S}([A-Z]{0,2}\d{6,9})(?![A-Za-z0-9])`), ok: (v) => v.length >= 7 && v.length <= 9 },
  { type: "LICENSE", rule: "license-in-context", atoms: ["driv"], re: cue(String.raw`(?:driver(?:['’]?s)?|driving)[ \t_]+licen[sc]e${N}${S}([A-Z0-9][A-Z0-9-]{3,22}[A-Z0-9])(?![A-Za-z0-9])`), ok: (v) => licenseShape(v) },
  { type: "LICENSE", rule: "license-in-context", atoms: ["licen", "dl"], re: cue(String.raw`(?:licen[sc]e|dl)[ \t_]*(?:number|num|no\.?|#|id)${S}([A-Z0-9][A-Z0-9-]{3,22}[A-Z0-9])(?![A-Za-z0-9])`), ok: (v) => licenseShape(v) },
  { type: "DOB", rule: "dob-in-context", atoms: ["dob", "d.o.b", "date", "birth", "born"],
    re: cue(String.raw`(?:d\.?o\.?b\.?|date[ \t_]+of[ \t_]+birth|birth[ \t_]?(?:date|day)|born(?:[ \t]+on)?)["']?[ \t]*(?:[:=-]|(?:is|was)\b)?[ \t]*["']?(?:on[ \t]+)?(${DATE})(?!\d)`) },
  { type: "BANK", rule: "aba-routing", atoms: ["routing", "aba", "rtn"], re: cue(String.raw`(?:routing(?:[ \t]+transit)?|aba|rtn)${N}${S}(\d{9})(?!\d)`), ok: (v) => abaValid(v) },
  { type: "BANK", rule: "bank-account-in-context", atoms: ["bank", "checking", "savings", "deposit", "acct", "a/c", "account"],
    re: cue(String.raw`(?:bank[ \t]+(?:account|acct)|(?:checking|savings|deposit)[ \t]+(?:account|acct)|acct\.?|a/c|account[ \t_]*(?:number|num|no\.?|#))${N}${S}(\d(?:-?\d){5,16})(?!\d)`) },
  { type: "TAX_ID", rule: "ein", atoms: ["ein", "fein", "tin", "employer", "tax", "federal"],
    re: cue(String.raw`(?:f?ein|tin|employer[ \t]+id(?:entification)?|(?:federal[ \t]+)?tax(?:payer)?[ \t_]*id(?:entification)?)${N}${S}(\d{2}-\d{7})(?!\d)`), ok: (v) => einValid(v) },
  { type: "SSN", rule: "ssn-in-context", atoms: ["ssn", "social"], re: cue(String.raw`(?:ssn|social[ \t]+security)${N}${S}(\d{3} \d{2} \d{4}|\d{9})(?!\d)`), ok: (v) => ssnValid(v) },
  { type: "TAX_ID", rule: "itin", atoms: ["itin", "ssn", "social"], re: cue(String.raw`(?:itin|ssn|social[ \t]+security)${N}${S}(\d{3} \d{2} \d{4}|\d{9})(?!\d)`), ok: (v) => itinValid(v) },
  { type: "NATIONAL_ID", rule: "ca-sin", atoms: ["sin", "social", "nas"], re: cue(String.raw`(?:sin|social[ \t]+insurance|nas)${N}${S}(\d{3}[ -]?\d{3}[ -]?\d{3})(?!\d)`), ok: (v) => sinValid(v) },
  { type: "VIN", rule: "vin-in-context", atoms: ["vin", "vehicle"], re: cue(String.raw`(?:vin|vehicle[ \t]+id(?:entification)?)${N}${S}([A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])`), ok: (v) => /\d/.test(v) && /[A-Za-z]/.test(v) },
  { type: "PHONE", rule: "phone-in-context", atoms: ["tel", "phone", "mobile", "cell", "fax", "whatsapp", "call", "text"],
    re: cue(String.raw`(?:tel(?:ephone)?|phone|mobile|cell|fax|whatsapp|call(?:[ \t]+(?:me|us))?|text(?:[ \t]+(?:me|us))?)\.?(?:[ \t]+(?:number|num|no\.?|#|on|at))?${S}(\+?\d{10,15}|\d{3}[-. ]\d{4})(?![\d-])`) },
  { type: "ID", rule: "id-in-context", atoms: ["account", "acct", "customer", "client", "member", "policy", "case", "order", "ticket", "invoice", "employee", "patient", "user", "subscriber", "claim", "booking", "reservation", "confirmation", "ref", "tracking", "loyalty", "record", "mrn", "badge", "student", "transaction", "txn"],
    re: cue(String.raw`(?:${ID_WORDS})(?:[ \t_-]*(id|number|num|no\.?|nbr|code|ref(?:erence)?))?(?![A-Za-z])["']?[ \t]*(#)?[ \t]*(?:[:=-]|(?:is|was)\b)?[ \t]*["']?#?([A-Za-z0-9][A-Za-z0-9_-]{2,30}[A-Za-z0-9])(?![A-Za-z0-9])`),
    ok: (v, m) => {
      if (!/\d/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      // Explicit: "order number", "order #", "MRN", or glued with a hyphen as in CASE-12345.
      if (m[1] || m[2] || /^(?:mrn|ref|txn)/i.test(m[0]) || (/-/.test(m[0].slice(0, -v.length)) && !/\s/.test(m[0]))) return true;
      return /[A-Za-z]/.test(v) && (v.match(/\d/g)?.length ?? 0) >= 2 && (/^[A-Z]/.test(v) || /[-_]/.test(v) || v.length >= 6);
    } },
];
function licenseShape(v: string) {
  const alnum = v.replace(/-/g, "").length;
  return alnum >= 5 && alnum <= 20 && (v.match(/\d/g)?.length ?? 0) >= 4;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Prefix tree of the cue atoms as one alternation, so the cue scan costs one pass whatever the cue count.
function trieSource(words: string[]): string {
  type Node = { end?: boolean; next: Map<string, Node> };
  const root: Node = { next: new Map() };
  for (const w of words) {
    let n = root;
    for (const c of w) { if (!n.next.has(c)) n.next.set(c, { next: new Map() }); n = n.next.get(c)!; }
    n.end = true;
  }
  const ser = (n: Node): string => (n.end ? "" : n.next.size === 1 ? [...n.next].map(([c, x]) => escapeRe(c) + ser(x))[0] : `(?:${[...n.next].map(([c, x]) => escapeRe(c) + ser(x)).join("|")})`);
  return ser(root);
}

/* ------------------------------------------------------------------ options and results */

export type ScrubMode = "label" | "mask" | "hash" | "synthetic" | "remove";
export type NameSensitivity = "context" | "balanced" | "aggressive";
export type CustomRule = { label: string; pattern: string; flags?: string };
export type RuleError = { label: string; pattern: string; error: string };

export type ScrubOptions = {
  /** Types to remove. Defaults to every type that is on in PII_TYPES. */
  types?: PiiType[];
  /** Literal terms to always remove (whole words, any letter case). */
  custom?: string[];
  /** In label mode, number the labels so the same value always gets the same label. Default true. */
  numbered?: boolean;
  /** label: [EMAIL_1]. mask: keeps the shape. hash: stable salted token. synthetic: consistent fake values. remove: deletes. */
  mode?: ScrubMode;
  /** Salt for hash mode and for synthetic filler characters. */
  salt?: string;
  /** context: only names next to a cue. balanced: adds the name dictionary and email linking. aggressive: also single first names. */
  nameSensitivity?: NameSensitivity;
  /** Values that must never be removed (exact match, any letter case). */
  allow?: string[];
  /** User regular expressions. Invalid or slow ones are reported in `ruleErrors`, never thrown. */
  rules?: CustomRule[];
  /** Set false to skip building the findings list (faster on big inputs). Default true. */
  findings?: boolean;
  /** Findings kept per scrubber before `truncated` is set. Default 50,000. Counts are never truncated. */
  maxFindings?: number;
};

export type Finding = { type: PiiType; start: number; end: number; value: string; replacement: string; rule: string; outStart: number };
export type Counts = Partial<Record<PiiType, number>>;
export type ScrubResult = {
  text: string; counts: Counts; total: number;
  findings: Finding[]; truncated: boolean;
  /** How many replacements each rule made, by rule name. */
  rules: Record<string, number>;
  ruleErrors: RuleError[];
  ms: number;
};
export type Scrubber = {
  /** Cleans one chunk. Labels, hashes, synthetic values and known names stay consistent across calls,
   *  and finding offsets continue from the previous chunk. */
  scrub(text: string): ScrubResult;
  ruleErrors: RuleError[];
};

/** Returns an error message for a custom rule, or null when it is usable. */
export function checkRule(rule: CustomRule): string | null {
  const p = rule.pattern;
  if (!p.trim()) return "Enter a pattern.";
  if (p.length > 500) return "Pattern is longer than 500 characters.";
  if (/[^imsu]/.test(rule.flags ?? "")) return "Only the flags i, m, s and u are supported.";
  // ponytail: a shape check, not a proof. The 2-second budget per chunk and the worker watchdog catch the rest.
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(p)) return "Nested repetition such as (a+)+ can freeze the page. Rewrite the pattern.";
  try {
    if (new RegExp(p, rule.flags ?? "").test("")) return "Pattern matches empty text. Make it more specific.";
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid pattern.";
  }
  return null;
}
const labelOf = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "CUSTOM";
const literal = (terms: string[]) => new RegExp(`(?<!\\w)(?:${terms.map(escapeRe).join("|")})(?!\\w)`, "gi");

/* ------------------------------------------------------------------ replacements */

const FAKE_FIRST = "Alex Jordan Taylor Morgan Casey Riley Jamie Avery Quinn Reese Rowan Blair Devon Emery Finley Harper Jules Marlow Noel Oakley Remy Shay Tatum Arden Blake Cameron Drew Ellis Frankie Hollis Indigo Kendall Logan Micah Nico Peyton Robin Sasha Toby Wynn".split(" ");
const FAKE_LAST = "Rivera Bennett Dawson Ellison Grayson Hale Irving Jensen Keller Lawson Mercer Nolan Osborne Preston Quincy Ramsey Sutton Thorne Underwood Vance Walsh Yates Zimmer Abbott Barlow Collins Draper Emerson Fleming Garner Hartley Ingram Jarvis Kimball Lowell Maddox Norris Pruitt Sawyer Tolliver".split(" ");
const KEEP_LAST4 = new Set<PiiType>(["PHONE", "CARD", "SSN", "BANK", "TAX_ID", "NATIONAL_ID", "IBAN"]);
const COMPACT_KEY = new Set<PiiType>(["PHONE", "CARD", "SSN", "BANK", "TAX_ID", "NATIONAL_ID", "IBAN", "MAC"]);

const normName = (raw: string) => {
  const w = raw.toLowerCase();
  return /[^a-z]/.test(w) ? w.normalize("NFD").replace(/[̀-ͯ'’.]/g, "") : w;
};
const nameKey = (v: string) => v.trim().split(/\s+/).map(normName).filter(Boolean).join(" ");

function mask(type: PiiType, v: string): string {
  const stars = (s: string) => s.replace(/[\p{L}\p{N}]/gu, "*");
  if (type === "EMAIL") {
    const at = v.lastIndexOf("@"), dot = v.lastIndexOf(".");
    const head = (s: string) => (s ? s[0] + "*".repeat(s.length - 1) : s);
    return dot > at ? `${head(v.slice(0, at))}@${head(v.slice(at + 1, dot))}${v.slice(dot)}` : stars(v);
  }
  if (type === "NAME") return v.replace(/[\p{L}\p{N}]+/gu, (w) => w[0] + "*".repeat(w.length - 1));
  if (KEEP_LAST4.has(type)) {
    let left = (v.match(/[A-Za-z0-9]/g)?.length ?? 0) - 4;
    return v.replace(/[A-Za-z0-9]/g, (c) => (left-- > 0 ? "*" : c));
  }
  return stars(v);
}

// Puts `digits` into the digit positions of `shape`, right-aligned, keeping every separator.
function fillDigits(shape: string, digits: string): string {
  let i = digits.length - (shape.match(/\d/g)?.length ?? 0);
  return shape.replace(/\d/g, () => digits[i++] ?? "0");
}
function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
// Same shape, different characters: digits stay digits, letters keep their case. Deterministic per value.
function scramble(v: string, seed: string, hex = false): string {
  if (v.startsWith("0x")) return "0x" + scramble(v.slice(2), seed, true);
  let x = fnv32(seed) || 1;
  const next = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
  return v.replace(/[A-Za-z0-9]/g, (c) => (c <= "9" ? String(next(10)) : String.fromCharCode((c <= "Z" ? 65 : 97) + next(hex ? 6 : 26))));
}

/* ------------------------------------------------------------------ the scrubber */

type Raw = { s: number; e: number; type: PiiType; rule: string; label?: string };
const DEFAULT_TYPES = PII_TYPES.filter((t) => t.on).map((t) => t.type);
const isAlnum = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWordChar = (c: number) => isAlnum(c) || c === 95 || (c >= 0xc0 && c <= 0x24f);
const TOKEN = new RegExp(`[${CAP}][${LET}]*(?:['’-][${LET}]+)*`, "g");
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

export function createScrubber(opts: ScrubOptions = {}): Scrubber {
  const on = new Set<PiiType>(opts.types ?? DEFAULT_TYPES);
  const numbered = opts.numbered ?? true;
  const mode = opts.mode ?? "label";
  const salt = opts.salt ?? "";
  const sens = opts.nameSensitivity ?? "balanced";
  const keepFindings = opts.findings ?? true;
  const maxFindings = opts.maxFindings ?? 50_000;
  const allow = new Set((opts.allow ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
  // ponytail: one alternation of the literal terms. Fine for hundreds of terms; switch to a keyword
  // automaton if lists of many thousands ever matter.
  const terms = [...new Set((opts.custom ?? []).map((t) => t.trim()).filter((t) => t.length > 1))].sort((a, b) => b.length - a.length);
  const customRe = terms.length ? literal(terms) : null;

  const ruleErrors: RuleError[] = [];
  const userRules: { label: string; pattern: string; re: RegExp; dead?: boolean }[] = [];
  for (const r of opts.rules ?? []) {
    if (!r.pattern.trim()) continue;
    const error = checkRule(r);
    if (error) ruleErrors.push({ label: r.label, pattern: r.pattern, error });
    else userRules.push({ label: labelOf(r.label), pattern: r.pattern, re: new RegExp(r.pattern, [...new Set(`g${r.flags ?? ""}`)].join("")) });
  }

  const detectors = DETECTORS.filter((d) => on.has(d.type));
  const cueMap = new Map<string, Cue[]>();
  for (const c of CUES) if (on.has(c.type)) for (const a of c.atoms) cueMap.set(a, [...(cueMap.get(a) ?? []), c]);
  const cueScan = cueMap.size ? new RegExp(trieSource([...cueMap.keys()]), "gi") : null;

  // State shared by every chunk this scrubber sees.
  const cache = new Map<string, string>();
  const counters = new Map<string, number>();
  const fullNames = new Map<string, string[][]>(); // first token -> known full names starting with it
  const nameParts = new Set<string>(); // single tokens redacted on their own
  const partOf = new Map<string, string | null>(); // token -> the one full name it belongs to (null when shared)
  let inBase = 0, outBase = 0, stored = 0;

  const partOk = (t: string) =>
    sens !== "context" && t.length >= 3 && !AMBIGUOUS.has(t) && !NOT_NAMES.has(t) && (sens === "aggressive" || GIVEN.has(t) || SURNAMES.has(t));
  const addName = (tokens: string[]): boolean => {
    const key = tokens.join(" ");
    let fresh = false;
    if (tokens.length > 1) {
      const list = fullNames.get(tokens[0]) ?? [];
      if (!list.some((x) => x.join(" ") === key)) { list.push(tokens); fullNames.set(tokens[0], list); fresh = true; }
    }
    for (const t of tokens) {
      if (!partOk(t)) continue;
      if (!nameParts.has(t)) { nameParts.add(t); fresh = true; }
      if (tokens.length > 1) partOf.set(t, partOf.has(t) && partOf.get(t) !== key ? null : key);
    }
    return fresh;
  };

  const count = (label: string) => { const n = (counters.get(label) ?? 0) + 1; counters.set(label, n); return n; };
  const fakeNamePart = (token: string, last: boolean): string => {
    const key = `NAME~${normName(token)}`;
    let fake = cache.get(key);
    if (!fake) {
      const list = last ? FAKE_LAST : FAKE_FIRST, i = count(last ? "~last" : "~first") - 1;
      fake = list[i % list.length] + (i >= list.length ? String(Math.floor(i / list.length) + 1) : "");
      cache.set(key, fake);
    }
    return token.length > 1 && token === token.toUpperCase() ? fake.toUpperCase() : fake;
  };
  const synthetic = (type: PiiType, label: string, v: string, key: string): string => {
    if (type === "NAME") {
      const words = v.trim().split(/\s+/);
      return words.map((w, i) => (/^[\p{L}]\.?$/u.test(w) ? w : fakeNamePart(w, words.length > 1 && i === words.length - 1))).join(" ");
    }
    const n = count(label);
    switch (type) {
      case "EMAIL": return `user${n}@example.com`;
      case "URL": return `https://example.com/page-${n}`;
      case "SECRET": return `example_secret_${n}`;
      case "ADDRESS": return `${100 + n} Example St`;
      case "CUSTOM": return `[${label}_${n}]`;
      case "PHONE": { // 555-01xx is reserved for fiction in every North American area code
        const d = digitsOf(v), line = `01${String(n % 100).padStart(2, "0")}`;
        const area = n < 100 ? "555" : String(200 + (Math.floor(n / 100) % 800));
        return fillDigits(v, d.length >= 10 ? d.slice(0, d.length - 10) + area + "555" + line : "5".repeat(Math.max(d.length - 4, 0)) + line);
      }
      case "CARD": { // 4000 00... is a test range; the last digit makes Luhn pass
        const len = digitsOf(v).length, body = "4000" + String(n).padStart(len - 5, "0").slice(-(len - 5));
        let check = 0;
        while (!luhnValid(body + check)) check++;
        return fillDigits(v, body + check);
      }
      case "IP": return v.includes(":") ? `2001:db8::${n.toString(16)}` : `${["192.0.2", "198.51.100", "203.0.113"][Math.floor((n - 1) / 254) % 3]}.${((n - 1) % 254) + 1}`;
      case "SSN": return fillDigits(v, "00000" + String(n % 10000).padStart(4, "0")); // area 000 is never issued
      case "DOB": return /^\d{4}/.test(v) ? "1970-01-01" : /^\d/.test(v) && !/[a-z]/i.test(v) ? v.replace(/\d+/g, (x, i: number) => (i === 0 || x.length < 3 ? "01" : x.length === 2 ? "70" : "1970")) : "January 1, 1970";
      default: return scramble(v, `${salt}\u0000${key}`, type === "MAC");
    }
  };
  const replacement = (type: PiiType, label: string, v: string): string => {
    if (mode === "remove") return "";
    if (mode === "mask") return mask(type, v);
    if (mode === "label" && !numbered) return `[${label}]`;
    let norm = type === "NAME" ? nameKey(v) : COMPACT_KEY.has(type) ? v.replace(/[^A-Za-z0-9]/g, "").toLowerCase() : v.toLowerCase();
    if (type === "NAME" && mode !== "synthetic") norm = partOf.get(norm) ?? norm; // "Dana" shares the label of "Dana Whitfield"
    const key = `${label}:${norm}`;
    let r = cache.get(key);
    if (r === undefined) {
      r = mode === "label" ? `[${label}_${count(label)}]` : mode === "hash" ? `[${label}_${fnv1a64(`${salt}\u0000${key}`).slice(0, 10)}]` : synthetic(type, label, v, key);
      cache.set(key, r);
    }
    return r;
  };

  // Names from a cue: drop trailing non-name words, reject role words such as "Team" or "Support".
  const cueName: Ok = (v) => {
    const words = v.split(/[ \t]+/);
    const stop = (w: string) => { const t = normName(w); return NOT_NAMES.has(t) && !GIVEN.has(t); };
    while (words.length && stop(words[words.length - 1])) words.pop();
    if (!words.length || stop(words[0]) || (words.length === 1 && words[0].length < 2)) return false;
    let end = 0, k = 0;
    for (const m of v.matchAll(/[^ \t]+/g)) if (k++ < words.length) end = m.index + m[0].length;
    return end;
  };

  function scanNames(text: string, push: (s: number, e: number, type: PiiType, rule: string) => void) {
    if (sens === "context" && !fullNames.size) return;
    const S: number[] = [], E: number[] = [], W: string[] = [];
    TOKEN.lastIndex = 0;
    for (let m; (m = TOKEN.exec(text)); ) {
      const s = m.index;
      let e = s + m[0].length, raw = m[0];
      if (s > 0 && isWordChar(text.charCodeAt(s - 1))) continue;
      const after = text.charCodeAt(e);
      if (after === 95 || (after >= 48 && after <= 57)) continue;
      if (raw.length > 2 && /['’]s$/.test(raw)) { raw = raw.slice(0, -2); e -= 2; }
      S.push(s); E.push(e); W.push(normName(raw));
    }
    const n = S.length;
    const caps = (i: number) => { const t = text.slice(S[i], E[i]); return t.length > 1 && t === t.toUpperCase(); };
    // Adjacent: only spaces or tabs between two tokens, or ". " after a one-letter initial.
    const adjacent = (a: number, b: number) => {
      let i = E[a];
      const end = S[b];
      if (end <= i || end - i > 4) return false;
      if (text.charCodeAt(i) === 46 && E[a] - S[a] === 1) i++;
      if (i === end) return false;
      for (; i < end; i++) { const c = text.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
      return true;
    };
    const pass = (dictionary: boolean): boolean => {
      let fresh = false;
      for (let i = 0; i < n; i++) {
        const w = W[i];
        const known = fullNames.get(w);
        if (known) {
          let best = 0;
          for (const k of known) {
            if (k.length <= best) continue;
            let j = 1;
            while (j < k.length && i + j < n && W[i + j] === k[j] && adjacent(i + j - 1, i + j)) j++;
            if (j === k.length) best = j;
          }
          if (best) { push(S[i], E[i + best - 1], "NAME", "name-propagated"); i += best - 1; continue; }
        }
        if (dictionary && w.length > 1 && GIVEN.has(w)) {
          let j = i + 1;
          if (j < n && adjacent(i, j)) {
            if (E[j] - S[j] === 1 && text.charCodeAt(E[j]) === 46 && j + 1 < n && adjacent(j, j + 1)) j++; // middle initial
            const w2 = W[j], ambiguous = AMBIGUOUS.has(w), surname = SURNAMES.has(w2) && !AMBIGUOUS.has(w2);
            const ok = w2.length < 2 || j === i ? false
              : caps(i) || caps(j) ? surname && !ambiguous && caps(i) === caps(j)
              : !ambiguous ? !NOT_NAMES.has(w2)
              : surname || (sens === "aggressive" && (SURNAMES.has(w2) || GIVEN.has(w2)));
            if (ok) {
              let end = j;
              if (j + 1 < n && adjacent(j, j + 1) && SURNAMES.has(W[j + 1]) && !AMBIGUOUS.has(W[j + 1]) && caps(j + 1) === caps(j)) end = j + 1;
              push(S[i], E[end], "NAME", "name-dictionary");
              const tokens = [w];
              for (let k = i + 1; k <= end; k++) if (W[k].length > 1) tokens.push(W[k]);
              if (addName(tokens)) fresh = true;
              i = end;
              continue;
            }
          }
          if (sens === "aggressive" && !AMBIGUOUS.has(w) && !NOT_NAMES.has(w) && !caps(i)) {
            push(S[i], E[i], "NAME", "name-dictionary");
            if (addName([w])) fresh = true;
            continue;
          }
        }
        if (nameParts.has(w)) push(S[i], E[i], "NAME", "name-propagated");
      }
      return fresh;
    };
    // A second pass applies names learned late in the chunk to their earlier mentions.
    if (pass(sens !== "context")) pass(false);
  }

  function scrub(text: string): ScrubResult {
    const t0 = now();
    const found: Raw[] = [];
    const push = (s: number, e: number, type: PiiType, rule: string, label?: string) => { found.push({ s, e, type, rule, label }); };

    if (customRe) {
      customRe.lastIndex = 0;
      for (let m; (m = customRe.exec(text)); ) push(m.index, m.index + m[0].length, "CUSTOM", "custom-term");
    }
    for (const r of userRules) {
      if (r.dead) continue;
      r.re.lastIndex = 0;
      const started = Date.now();
      let hits = 0;
      for (let m; (m = r.re.exec(text)); ) {
        if (!m[0]) { r.re.lastIndex++; continue; }
        push(m.index, m.index + m[0].length, "CUSTOM", `custom-regex:${r.label}`, r.label);
        if (++hits % 256 === 0 && (hits > 200_000 || Date.now() - started > 2000)) {
          r.dead = true;
          ruleErrors.push({ label: r.label, pattern: r.pattern, error: "Stopped: the pattern took more than 2 seconds or matched more than 200,000 times. Make it more specific." });
          break;
        }
      }
    }

    const cueNames: [number, number][] = [];
    for (const d of detectors) {
      d.re.lastIndex = 0;
      const isName = d.type === "NAME";
      for (let m; (m = d.re.exec(text)); ) {
        let value = d.g ? m[d.g] : m[0];
        if (!value) continue;
        const start = d.g ? m.index + m[0].length - (d.tail ?? 0) - value.length : m.index;
        const verdict = isName ? cueName(value, text, start, m) : d.ok ? d.ok(value, text, start, m) : true;
        if (verdict === false || verdict === 0) continue;
        if (typeof verdict === "number") value = value.slice(0, verdict);
        push(start, start + value.length, d.type, typeof d.rule === "string" ? d.rule : d.rule(value, text, start));
        if (isName) cueNames.push([start, start + value.length]);
      }
    }
    for (const [s, e] of cueNames) addName(text.slice(s, e).split(/[ \t]+/).map(normName).filter((t) => t.length > 1));

    // Emails: anchor on "@" and grow outwards, which stays linear on any input.
    const wantEmail = on.has("EMAIL"), linkNames = on.has("NAME") && sens !== "context";
    if (wantEmail || linkNames) {
      for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
        let s = at;
        while (s > 0 && at - s < 64 && /[A-Za-z0-9._%+-]/.test(text[s - 1])) s--;
        while (s < at && text[s] === ".") s++;
        const domain = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.exec(text.slice(at + 1, at + 256));
        if (s === at || !domain) continue;
        if (wantEmail) push(s, at + 1 + domain[0].length, "EMAIL", "email");
        // dana.whitfield@ also identifies "Dana Whitfield" wherever it is written out.
        const who = linkNames && /^([a-z]{2,20})[._-]([a-z]{2,20})\d{0,4}$/.exec(text.slice(s, at).toLowerCase());
        if (who && !NOT_NAMES.has(who[1]) && !NOT_NAMES.has(who[2])) {
          if (GIVEN.has(who[1]) || (SURNAMES.has(who[2]) && !GIVEN.has(who[2]))) addName([who[1], who[2]]);
          else if (GIVEN.has(who[2]) && SURNAMES.has(who[1])) addName([who[2], who[1]]);
        }
      }
    }

    if (cueScan) {
      cueScan.lastIndex = 0;
      for (let m; (m = cueScan.exec(text)); ) {
        const at = m.index;
        if (at > 0 && isAlnum(text.charCodeAt(at - 1))) continue;
        for (const c of cueMap.get(m[0].toLowerCase()) ?? []) {
          c.re.lastIndex = at;
          const r = c.re.exec(text);
          if (!r) continue;
          let g = r.length - 1;
          while (g > 0 && r[g] === undefined) g--;
          const span = g > 0 ? r.indices?.[g] : undefined;
          if (!span || (c.ok && !c.ok(r[g], r, text))) continue;
          push(span[0], span[1], c.type, typeof c.rule === "string" ? c.rule : c.rule(r[g], r));
          break;
        }
      }
    }

    if (on.has("NAME")) scanNames(text, push);

    // Resolve overlaps: earliest start wins, then the higher-priority type, then the longer match.
    found.sort((a, b) => a.s - b.s || PRIORITY[a.type] - PRIORITY[b.type] || b.e - a.e);
    const counts: Counts = {};
    const rules: Record<string, number> = {};
    const findings: Finding[] = [];
    const parts: string[] = [];
    let pos = 0, kept = 0, outLen = 0, total = 0, truncated = false;
    for (const f of found) {
      if (f.s < pos || f.s < kept) continue;
      const value = text.slice(f.s, f.e);
      if (allow.size && allow.has(value.toLowerCase())) { kept = f.e; continue; } // allowlisted: protect the whole span
      const rep = replacement(f.type, f.label ?? f.type, value);
      parts.push(text.slice(pos, f.s), rep);
      outLen += f.s - pos;
      if (keepFindings) {
        if (stored < maxFindings) { findings.push({ type: f.type, start: inBase + f.s, end: inBase + f.e, value, replacement: rep, rule: f.rule, outStart: outBase + outLen }); stored++; }
        else truncated = true;
      }
      outLen += rep.length;
      pos = f.e;
      counts[f.type] = (counts[f.type] ?? 0) + 1;
      rules[f.rule] = (rules[f.rule] ?? 0) + 1;
      total++;
    }
    parts.push(text.slice(pos));
    inBase += text.length;
    outBase += outLen + text.length - pos;
    return { text: parts.join(""), counts, total, findings, truncated, rules, ruleErrors, ms: now() - t0 };
  }

  return { scrub, ruleErrors };
}

/** Removes personal data from `input`. One-shot form of `createScrubber(opts).scrub(input)`. */
export function scrub(input: string, opts: ScrubOptions = {}): ScrubResult {
  return createScrubber(opts).scrub(input);
}

/** Adds the counts in `from` to `into` (for totals across chunks, files or columns). */
export function addCounts<K extends string>(into: Partial<Record<K, number>>, from: Partial<Record<K, number>>) {
  for (const k in from) into[k] = (into[k] ?? 0) + (from[k] ?? 0);
  return into;
}

/* ------------------------------------------------------------------ tables (CSV, TSV, JSON, JSONL) */

export type ColumnPolicy = "keep" | "scrub" | "drop" | "hash";
export type TableRow = Record<string, unknown>;
export type TableResult = {
  rows: TableRow[]; counts: Counts; total: number;
  columns: Record<string, { policy: ColumnPolicy; total: number; counts: Counts }>;
  rules: Record<string, number>; ruleErrors: RuleError[]; ms: number;
};

const CELL_SEP = "\n␞\n"; // joins cells into one scrub call; no detector can match across it
const BATCH = 2000;
// Applies `fn` to every string inside a cell. Numbers and booleans keep their type unless something was removed.
function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") { const s = String(v), r = fn(s); return r === s ? v : r; }
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

/** Cleans records column by column. keep: untouched. scrub: pattern scrubbing inside each cell.
 *  drop: the column is removed. hash: the whole cell becomes a stable salted hash (FNV-1a, not cryptographic).
 *  Columns without a policy use `defaultPolicy` (scrub). */
export function scrubTable(rows: TableRow[], policies: Record<string, ColumnPolicy> = {}, opts: ScrubOptions & { defaultPolicy?: ColumnPolicy } = {}): TableResult {
  const t0 = now();
  const scrubber = createScrubber({ ...opts, findings: false });
  const policyOf = (c: string) => policies[c] ?? opts.defaultPolicy ?? "scrub";
  const columns: TableResult["columns"] = {};
  const hashes = new Map<string, string>();
  const hash = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (!hashes.has(s)) hashes.set(s, hashValue(s, opts.salt));
    return hashes.get(s)!;
  };
  const out = rows.map((row) => {
    const next: TableRow = {};
    for (const [k, v] of Object.entries(row)) {
      const p = policyOf(k);
      columns[k] ??= { policy: p, total: 0, counts: {} };
      if (p !== "drop") next[k] = p === "hash" && v !== "" && v != null ? hash(v) : v;
    }
    return next;
  });

  const counts: Counts = {}, rules: Record<string, number> = {};
  let total = 0;
  const tally = (col: string, r: ScrubResult) => {
    addCounts(columns[col].counts, r.counts); addCounts(counts, r.counts); addCounts(rules, r.rules);
    columns[col].total += r.total; total += r.total;
  };
  for (const col of Object.keys(columns)) {
    if (columns[col].policy !== "scrub") continue;
    for (let from = 0; from < out.length; from += BATCH) {
      const to = Math.min(from + BATCH, out.length);
      const strings: string[] = [];
      for (let i = from; i < to; i++) mapStrings(out[i][col], (s) => (strings.push(s), s));
      if (!strings.length) continue;
      const joined = scrubber.scrub(strings.join(CELL_SEP));
      let cleaned = joined.text.split(CELL_SEP);
      if (cleaned.length === strings.length) tally(col, joined);
      else cleaned = strings.map((s) => { const r = scrubber.scrub(s); tally(col, r); return r.text; }); // a match crossed cells: redo one by one
      let k = 0;
      for (let i = from; i < to; i++) if (col in out[i]) out[i][col] = mapStrings(out[i][col], () => cleaned[k++]);
    }
  }
  return { rows: out, counts, total, columns, rules, ruleErrors: scrubber.ruleErrors, ms: now() - t0 };
}

export type ColumnInfo = { name: string; types: PiiType[]; sample: string; suggested: ColumnPolicy; reason: "detected" | "header" | "text" | "none" };
const HEADER_WORDS = new Set("name firstname lastname fullname surname forename username login email phone mobile cell tel fax address street zip postcode postal dob birthdate birthday birth ssn sin passport license licence iban card password passwd secret token ip".split(" "));
const HEADER_NOT_PERSON = /product|file|company|org|plan|event|field|column|table|city|country|state|brand|item|sku|category|project|team|host|domain/;

/** Looks at up to 2,000 rows per column and suggests a policy: scrub where patterns are found,
 *  hash where the header names a direct identifier that patterns cannot see (a column of first names),
 *  scrub for free text, keep for the rest. */
export function analyzeColumns(rows: TableRow[], opts: ScrubOptions = {}): ColumnInfo[] {
  const sample = rows.slice(0, 2000);
  const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return [...new Set(rows.flatMap((r) => Object.keys(r)))].map((name): ColumnInfo => {
    const values = sample.map((r) => cell(r[name]));
    const filled = values.filter((v) => v.trim() !== "");
    const counts = scrub(values.join("\n"), { ...opts, numbered: false, findings: false }).counts;
    const floor = Math.max(1, Math.min(3, Math.ceil(sample.length * 0.02)));
    const types = (Object.entries(counts) as [PiiType, number][]).filter(([, n]) => n >= floor).map(([t]) => t);
    const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    const header = words.some((w) => HEADER_WORDS.has(w)) && !HEADER_NOT_PERSON.test(name.toLowerCase());
    const text = filled.length > 0 && filled.filter((v) => /\s/.test(v.trim())).length / filled.length > 0.5;
    const reason = types.length ? "detected" : header ? "header" : text ? "text" : "none";
    return { name, types, sample: (filled[0] ?? "").slice(0, 80), suggested: reason === "header" ? "hash" : reason === "none" ? "keep" : "scrub", reason };
  });
}

/** Rough token count used by AI labs to size text: about four characters per token in English. */
export const approxTokens = (chars: number) => Math.round(chars / 4);
