// Parsers behind the free "Parse" tools: Slack exports, email, help desk tickets, chat dataset
// formats, logs and document text. Pure and browser-only at runtime; tested by `npm test`.
import { unzipSync } from "fflate";
import { scrub, approxTokens } from "./pii.ts";
import { toRows, type Row } from "./profile.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clean = (t: string, on?: boolean) => (on && t ? scrub(t, { numbered: false }).text : t);
const dateSpan = (dates: string[]) => {
  const d = dates.filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x)).map((x) => x.slice(0, 10)).sort();
  return { from: d[0] ?? "", to: d[d.length - 1] ?? "" };
};

export const toJsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");

/** Seconds, milliseconds or a date string to ISO 8601. Unparseable values are returned as text. */
export function toIso(v: unknown): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : /^\d{9,13}(\.\d+)?$/.test(String(v)) ? +String(v) : NaN;
  const d = new Date(Number.isNaN(n) ? String(v) : n < 1e11 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// ---------- zip ----------

const ZIP_BATCH = 16e6; // bytes of uncompressed data held at once
const ZIP_ENTRY_MAX = 200e6; // skips absurd entries (zip bombs)

/** Calls `on` for each wanted zip entry, inflating about 16 MB at a time instead of the whole archive. */
export function eachZipEntry(zip: Uint8Array, want: (name: string) => boolean, on: (name: string, data: Uint8Array) => void): number {
  let next = 0, count = 0;
  for (;;) {
    let i = 0, size = 0, stop = -1;
    const batch = unzipSync(zip, {
      filter: (f) => {
        const idx = i++;
        if (idx < next || stop >= 0) return false;
        if (f.name.endsWith("/") || f.originalSize > ZIP_ENTRY_MAX || !want(f.name)) return false;
        if (size > 0 && size + f.originalSize > ZIP_BATCH) { stop = idx; return false; }
        size += f.originalSize;
        return true;
      },
    });
    for (const [name, data] of Object.entries(batch)) { on(name, data); count++; }
    if (stop < 0) return count;
    next = stop;
  }
}

// ---------- HTML and entities ----------

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™" };

export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
  if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
  const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});

const tidy = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Pure HTML to text: drops script, style, nav and footer; keeps headings, paragraphs and lists as lines.
 *  ponytail: regex-based. The browser parses with DOMParser first and passes clean markup here;
 *  `<pre>` blocks lose their line breaks. */
export function htmlToText(html: string): string {
  return tidy(decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|nav|footer|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<\/?(p|div|h[1-6]|section|article|ul|ol|table|tr|blockquote|pre|header|main|aside|dl|dt|dd|figure|figcaption|hr|title|body|html)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\n- \s+/g, "\n- ")));
}

export const htmlTitle = (html: string) =>
  tidy(decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "").replace(/<[^>]*>/g, ""))).replace(/\s+/g, " ");

// ---------- 1. Slack export ----------

export type SlackMessage = {
  ts: string; user?: string; bot_id?: string; username?: string; subtype?: string; text?: string; thread_ts?: string;
  reactions?: { name?: string; count?: number }[]; files?: { name?: string; title?: string; filetype?: string }[];
};
export type SlackData = {
  users: Record<string, string>; bots: Record<string, boolean>; channels: Record<string, string>;
  days: { channel: string; date: string; messages: SlackMessage[] }[]; skipped: number;
};
export const emptySlack = (): SlackData => ({ users: {}, bots: {}, channels: {}, days: [], skipped: 0 });

/** Routes one file of a Slack export (users.json, channels.json or <channel>/<date>.json) into `data`. */
export function addSlackFile(data: SlackData, path: string, text: string): void {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? "";
  let json: unknown;
  try { json = JSON.parse(text); } catch { data.skipped++; return; }
  if (!Array.isArray(json)) { data.skipped++; return; }
  if (file === "users.json") {
    for (const u of json) {
      if (!isObj(u) || typeof u.id !== "string") continue;
      const p = isObj(u.profile) ? u.profile : {};
      data.users[u.id] = str(p.display_name) || str(p.real_name) || str(u.real_name) || str(u.name) || u.id;
      if (u.is_bot) data.bots[u.id] = true;
    }
  } else if (["channels.json", "groups.json", "mpims.json", "dms.json"].includes(file)) {
    for (const c of json) if (isObj(c) && typeof c.id === "string" && typeof c.name === "string") data.channels[c.id] = c.name;
  } else {
    const messages = json.filter((m): m is SlackMessage => isObj(m) && typeof m.ts === "string");
    if (!messages.length) { data.skipped++; return; }
    data.days.push({ channel: parts.length > 1 ? parts[parts.length - 2] : "export", date: file.replace(/\.json$/i, ""), messages });
  }
}

export const slackChannels = (data: SlackData) => {
  const n: Record<string, number> = {};
  for (const d of data.days) n[d.channel] = (n[d.channel] ?? 0) + d.messages.length;
  return Object.entries(n).map(([name, messages]) => ({ name, messages })).sort((a, b) => a.name.localeCompare(b.name));
};

export type SlackOptions = {
  group?: "thread" | "day"; pseudonymize?: boolean; dropBots?: boolean; dropSystem?: boolean;
  channels?: string[]; from?: string; to?: string; scrub?: boolean;
};
type SlackOut = { ts: string; thread_ts: string; user: string; text: string; reactions: number; files: string[]; subtype?: string };
const SLACK_KEEP = ["bot_message", "thread_broadcast", "file_share", "me_message"];
const tsIso = (ts: string) => { const d = new Date(parseFloat(ts) * 1000); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); };

export function buildSlack(data: SlackData, o: SlackOptions = {}) {
  const pseudo = o.pseudonymize ?? true;
  const days = [...data.days].sort((a, b) => a.channel.localeCompare(b.channel) || a.date.localeCompare(b.date));
  const author = (m: SlackMessage) => m.user ?? m.bot_id ?? m.username ?? "unknown";
  const ids = new Map<string, string>();
  const who = (id: string, fallback?: string) => {
    if (!pseudo) return data.users[id] ?? fallback ?? id;
    if (!ids.has(id)) ids.set(id, `user_${ids.size + 1}`);
    return ids.get(id)!;
  };
  // Number every author up front so pseudonyms do not shift when channels or dates are filtered.
  for (const d of days) for (const m of d.messages) who(author(m));

  const markup = (t: string) => decodeEntities(t.replace(/<([^<>\n]+)>/g, (_, body: string) => {
    const bar = body.indexOf("|");
    const target = bar < 0 ? body : body.slice(0, bar), label = bar < 0 ? "" : body.slice(bar + 1);
    if (target[0] === "@") return "@" + who(target.slice(1), label || undefined);
    if (target[0] === "#") return "#" + (label || data.channels[target.slice(1)] || target.slice(1));
    if (target[0] === "!") return label || "@" + target.slice(1).split("^")[0];
    if (/^mailto:/i.test(target)) return label || target.slice(7);
    return label && label !== target ? `${label} (${target})` : target;
  }));

  const groups = new Map<string, { channel: string; date: string; messages: SlackOut[] }>();
  const threads = new Set<string>(), authors = new Set<string>(), channels = new Set<string>(), dates: string[] = [];
  let messages = 0, chars = 0;
  for (const d of days) {
    if (o.channels && !o.channels.includes(d.channel)) continue;
    for (const m of d.messages) {
      const ts = tsIso(m.ts);
      if (!ts) continue;
      const date = ts.slice(0, 10);
      if ((o.from && date < o.from) || (o.to && date > o.to)) continue;
      const bot = !!m.bot_id || m.subtype === "bot_message" || !!(m.user && data.bots[m.user]);
      if (bot && (o.dropBots ?? true)) continue;
      const system = !!m.subtype && !SLACK_KEEP.includes(m.subtype);
      if (system && (o.dropSystem ?? true)) continue;
      const thread = m.thread_ts ?? m.ts;
      const out: SlackOut = {
        ts, thread_ts: tsIso(thread) || ts, user: who(author(m), m.username),
        text: clean(markup(m.text ?? ""), o.scrub),
        reactions: (m.reactions ?? []).reduce((n, r) => n + (r.count ?? 0), 0),
        files: (m.files ?? []).map((f) => f.name || f.title || f.filetype || "file"),
      };
      if (m.subtype) out.subtype = m.subtype;
      const key = o.group === "day" ? `${d.channel}\u0001${d.date}` : `${d.channel}\u0001${thread}`;
      if (!groups.has(key)) groups.set(key, { channel: d.channel, date: d.date, messages: [] });
      groups.get(key)!.messages.push(out);
      threads.add(`${d.channel}\u0001${thread}`); authors.add(author(m)); channels.add(d.channel); dates.push(date);
      messages++; chars += out.text.length;
    }
  }
  const records = [...groups.values()].map((g) => {
    g.messages.sort((a, b) => a.ts.localeCompare(b.ts));
    return o.group === "day"
      ? { channel: g.channel, date: g.date, messages: g.messages }
      : { channel: g.channel, ts: g.messages[0].ts, thread_ts: g.messages[0].thread_ts, messages: g.messages.map(({ thread_ts: _t, ...rest }) => rest) };
  }).sort((a, b) => a.channel.localeCompare(b.channel) || a.messages[0].ts.localeCompare(b.messages[0].ts));
  return { records, stats: { channels: channels.size, messages, threads: threads.size, users: authors.size, ...dateSpan(dates), tokens: approxTokens(chars) } };
}

// ---------- 2. Email (.eml / .mbox) ----------

/** Bytes to a string with one character per byte, so transfer encodings can be decoded before the charset. */
export const bytesToBinary = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
const charsetDecode = (bin: string, charset: string) => {
  if (/[^\u0000-ÿ]/.test(bin)) return bin; // already decoded text, not bytes
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try { return new TextDecoder(charset || "utf-8").decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
};
const qp = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const b64 = (s: string) => { try { return atob(s.replace(/[^A-Za-z0-9+/=]/g, "")); } catch { return s; } };

/** Decodes RFC 2047 encoded-words such as =?UTF-8?B?...?= and =?iso-8859-1?Q?...?= in a header value. */
export const decodeWords = (s: string) => s
  .replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bq]\?)/gi, "$1")
  .replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (_, cs: string, enc: string, body: string) => charsetDecode(enc.toLowerCase() === "b" ? b64(body) : qp(body.replace(/_/g, " ")), cs));

const splitHead = (raw: string): [string, string] => { const m = /^\r?\n|\r?\n\r?\n/.exec(raw); return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""]; };
const headersOf = (block: string) => {
  const h: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return h;
};
const param = (v: string, name: string) => {
  const m = new RegExp(`\\b${name}(\\*?)=(?:"([^"]*)"|([^;\\s]*))`, "i").exec(v);
  const val = m ? m[2] ?? m[3] ?? "" : "";
  if (!m?.[1]) return val;
  try { return decodeURIComponent(val.replace(/^[\w-]*'[^']*'/, "")); } catch { return val; } // RFC 2231
};

export type Attachment = { name: string; type: string };
export type Email = { id: string; refs: string[]; from: string; to: string[]; cc: string[]; date: string; subject: string; text: string; attachments: Attachment[] };
type Parts = { plain: string[]; html: string[]; attachments: Attachment[] };

function walkMime(raw: string, out: Parts, depth = 0): Record<string, string> {
  const [head, body] = splitHead(raw);
  const h = headersOf(head);
  const ct = h["content-type"] ?? "text/plain", type = ct.split(";")[0].trim().toLowerCase();
  const disp = h["content-disposition"] ?? "";
  const boundary = param(ct, "boundary");
  if (type.startsWith("multipart/") && boundary && depth < 10) {
    body.split(`--${boundary}--`)[0].split(new RegExp(`(?:^|\\r?\\n)--${esc(boundary)}[ \\t]*\\r?\\n`)).slice(1).forEach((p) => walkMime(p, out, depth + 1));
  } else if (/^attachment/i.test(disp) || (type !== "text/plain" && type !== "text/html")) {
    out.attachments.push({ name: decodeWords(param(disp, "filename") || param(ct, "name")), type });
  } else {
    const enc = (h["content-transfer-encoding"] ?? "").toLowerCase();
    const text = charsetDecode(enc === "base64" ? b64(body) : enc === "quoted-printable" ? qp(body) : body, param(ct, "charset"));
    (type === "text/html" ? out.html : out.plain).push(text);
  }
  return h;
}

const addressList = (s: string) => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean);

/** Parses one RFC 822 message. `raw` is a binary string (see bytesToBinary) or plain ASCII. */
export function parseEml(raw: string, strip: (html: string) => string = htmlToText): Email {
  const out: Parts = { plain: [], html: [], attachments: [] };
  const h = walkMime(raw, out);
  const hv = (k: string) => decodeWords(charsetDecode(h[k] ?? "", "utf-8"));
  const ids = (v?: string) => v?.match(/<[^<>\s]+>/g) ?? [];
  const d = new Date(h.date ?? "");
  return {
    id: ids(h["message-id"])[0] ?? "", refs: [...new Set([...ids(h.references), ...ids(h["in-reply-to"])])],
    from: hv("from"), to: addressList(hv("to")), cc: addressList(hv("cc")),
    date: Number.isNaN(d.getTime()) ? "" : d.toISOString(), subject: hv("subject"),
    text: (out.plain.length ? out.plain.join("\n\n") : out.html.map(strip).join("\n\n")).replace(/\r\n?/g, "\n").trim(),
    attachments: out.attachments,
  };
}

/** Splits an mbox file on its "From " separator lines and undoes ">From " escaping. */
export const splitMbox = (raw: string) => raw.split(/^From \S+.*\d{2}:\d{2}.*\r?\n/m).filter((m) => m.trim()).map((m) => m.replace(/^>(>*From )/gm, "$1"));

/** Messages in an .eml or .mbox file. Returns [] when the text does not look like email. */
export function parseMailFile(name: string, raw: string, strip?: (html: string) => string): Email[] {
  const list = /\.mbox$/i.test(name) || /^From \S+.*\d{2}:\d{2}/.test(raw) ? splitMbox(raw) : [raw];
  return list.map((m) => parseEml(m, strip)).filter((e) => e.from || e.id || (e.subject && e.date));
}

const WROTE = /^(On|Am|Le|El) .{5,}(wrote|schrieb[^:]*|a écrit|escribió)\s*:$/i;
const ORIGINAL = /^-{2,}\s*Original Message\s*-{2,}/i;

/** Removes quoted replies and signatures from a plain-text body.
 *  ponytail: line heuristics for the common mail clients, not a trained model. */
export function cleanBody(text: string, o: { quotes?: boolean; signatures?: boolean } = {}): string {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (o.quotes ?? true) {
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim(), next = lines.slice(i + 1, i + 4).map((x) => x.trim());
      if (ORIGINAL.test(t) || (/^From:\s/.test(t) && next.some((n) => /^(Sent|Date):\s/.test(n)))) break; // Outlook quotes without ">"
      if (t.startsWith(">") || WROTE.test(t)) continue;
      if (/^(On|Am|Le|El) /.test(t) && WROTE.test(`${t} ${next[0] ?? ""}`)) { i++; continue; }
      kept.push(lines[i]);
    }
    while (kept.length && /^[_-]{5,}$|^$/.test(kept[kept.length - 1].trim())) kept.pop();
    lines = kept;
  }
  if (o.signatures ?? true) {
    const s = lines.findIndex((l) => /^-- ?$/.test(l) || /^(Sent from my |Get Outlook for )/i.test(l.trim()));
    if (s >= 0) lines = lines.slice(0, s);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const REPLY = /^\s*((re|fwd?|aw|wg|sv|tr)\s*(\[\d+\])?:\s*)+/i;
export const normalizeSubject = (s: string) => s.replace(REPLY, "").replace(/\s+/g, " ").trim().toLowerCase();

export type EmailOptions = { pseudonymize?: boolean; stripQuotes?: boolean; stripSignatures?: boolean; scrub?: boolean };

/** Groups messages into threads by References / In-Reply-To, then by normalized subject. */
export function buildEmailThreads(emails: Email[], o: EmailOptions = {}) {
  const pseudo = o.pseudonymize ?? true;
  const seen = new Set<string>();
  const list = emails.filter((e) => !e.id || (!seen.has(e.id) && !!seen.add(e.id)))
    .map((e, i) => ({ e, key: e.id || `#${i}` })).sort((a, b) => (a.e.date || "9").localeCompare(b.e.date || "9"));

  const parent = new Map<string, string>();
  const find = (k: string) => { let r = k; while (parent.has(r)) r = parent.get(r)!; return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const claimed = new Set<string>();
  for (const { e, key } of list) {
    for (const r of e.refs) union(r, key);
    const subject = normalizeSubject(e.subject);
    if (!subject) continue;
    if (!REPLY.test(e.subject)) { if (!claimed.has(subject)) { claimed.add(subject); union(key, `subject:${subject}`); } }
    else if (!e.refs.some((r) => seen.has(r))) union(`subject:${subject}`, key); // reply whose parent is not in the file
  }

  const people = new Map<string, string>(), terms = new Map<string, string>();
  const who = (s: string) => {
    const m = /<([^<>]+)>/.exec(s);
    const address = (m ? m[1] : s).trim().toLowerCase(), name = m ? s.slice(0, m.index).trim().replace(/^["']|["']$/g, "") : "";
    if (!address) return "";
    if (!people.has(address)) people.set(address, `person_${people.size + 1}`);
    const p = people.get(address)!;
    terms.set(address, p);
    if (/\S\s+\S/.test(name)) terms.set(name.toLowerCase(), p);
    return pseudo ? p : s.trim();
  };
  const named = list.map(({ e, key }) => ({ e, key, from: who(e.from), to: e.to.map(who).filter(Boolean), cc: e.cc.map(who).filter(Boolean) }));
  // Known addresses and full display names are also replaced inside subjects and bodies.
  const known = pseudo && terms.size ? new RegExp([...terms.keys()].sort((a, b) => b.length - a.length).map(esc).join("|"), "gi") : null;
  const prose = (t: string) => clean(known ? t.replace(known, (m) => terms.get(m.toLowerCase()) ?? m) : t, o.scrub);

  const groups = new Map<string, typeof named>();
  for (const n of named) { const root = find(n.key); if (!groups.has(root)) groups.set(root, []); groups.get(root)!.push(n); }
  let chars = 0, attachments = 0;
  const records = [...groups.values()].map((g, i) => {
    const messages = g.map(({ e, from, to, cc }) => {
      const body = (o.stripQuotes ?? true) || (o.stripSignatures ?? true) ? cleanBody(e.text, { quotes: o.stripQuotes ?? true, signatures: o.stripSignatures ?? true }) : e.text;
      const text = prose(body);
      chars += text.length; attachments += e.attachments.length;
      return { date: e.date, from, to, cc, subject: prose(e.subject), text, attachments: e.attachments };
    });
    return { id: `thread_${i + 1}`, subject: messages[0].subject, started: messages[0].date, participants: [...new Set(messages.flatMap((m) => [m.from, ...m.to, ...m.cc]).filter(Boolean))], messages };
  });
  return { records, stats: { threads: records.length, messages: list.length, people: people.size, attachments, ...dateSpan(list.map((x) => x.e.date)), tokens: approxTokens(chars) } };
}

// ---------- 3. Help desk tickets ----------

export type Turn = { role: "customer" | "agent" | "system"; time: string; text: string };
export type Conversation = { id: string; created: string; subject: string; status: string; tags: string[]; turns: Turn[] };
export type TicketShape = "zendesk" | "intercom" | "freshdesk" | "hubspot" | "jira" | "generic";
export type TicketMapping = { id: string; created: string; subject: string; customer: string; agent: string; status: string; tags: string };
export const TICKET_FIELDS: { key: keyof TicketMapping; label: string }[] = [
  { key: "id", label: "Ticket ID" }, { key: "created", label: "Created time" }, { key: "subject", label: "Subject" },
  { key: "customer", label: "Customer message" }, { key: "agent", label: "Agent replies or comment list" },
  { key: "status", label: "Status" }, { key: "tags", label: "Tags" },
];

export const getPath = (o: unknown, path: string): unknown =>
  !path ? undefined : isObj(o) && path in o ? o[path] : path.split(".").reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), o);

/** Dot paths of the fields in the first records. Arrays and rich-text documents are leaves. */
export function fieldPaths(records: Obj[], limit = 50): string[] {
  const out = new Set<string>();
  const walk = (o: Obj, pre: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      const p = pre ? `${pre}.${k}` : k;
      if (isObj(v) && v.type !== "doc" && depth < 3) walk(v, p, depth + 1); else out.add(p);
    }
  };
  records.slice(0, limit).forEach((r) => walk(r, "", 0));
  return [...out];
}

const WRAPPERS = ["tickets", "conversations", "issues", "results", "data", "items", "records", "rows"];

/** Reads a JSON, JSONL or CSV export into records. Throws a readable message when it cannot. */
export function parseRecords(name: string, text: string): Obj[] {
  const t = text.trim();
  if (!t) throw new Error("The input is empty.");
  let rows: unknown[];
  if (t[0] === "{" || t[0] === "[") {
    let v: unknown;
    try { v = JSON.parse(t); }
    catch {
      v = t.split(/\r?\n/).map((l, i) => {
        if (!l.trim()) return null;
        try { return JSON.parse(l) as unknown; } catch { throw new Error(`Line ${i + 1} is not valid JSON. Expected a JSON array, JSONL with one record per line, or CSV.`); }
      }).filter((x) => x !== null);
    }
    if (isObj(v)) {
      const o = v, key = WRAPPERS.find((k) => Array.isArray(o[k]));
      if (key === "tickets" && Array.isArray(v.comments)) {
        // Tickets and comments exported side by side: attach each comment to its ticket.
        const by = new Map<string, unknown[]>();
        for (const c of v.comments) if (isObj(c) && c.ticket_id != null) by.set(String(c.ticket_id), [...(by.get(String(c.ticket_id)) ?? []), c]);
        v = (v.tickets as unknown[]).map((tk) => (isObj(tk) && !Array.isArray(tk.comments) ? { ...tk, comments: by.get(String(tk.id)) ?? [] } : tk));
      } else v = key ? (v as Obj)[key] : [v];
    }
    rows = Array.isArray(v) ? v : [];
  } else rows = toRows(/\.tsv$/i.test(name) ? "a.tsv" : "a.csv", text);
  const records = rows.filter(isObj);
  if (!records.length) throw new Error("No records found. Expected a JSON array of objects, JSONL with one record per line, or CSV with a header row.");
  return records;
}

const GUESS: [keyof TicketMapping, RegExp][] = [
  ["id", /^(id|key|number|(ticket|case|conversation|issue)[ _.-]?(id|number|key))$/i],
  ["created", /creat|opened|submitted|^date$|timestamp/i],
  ["subject", /subject|title|summary|^name$|ticket name/i],
  ["status", /status|^state$/i],
  ["tags", /^tags?$|labels?|categor/i],
  ["agent", /repl|response|answer|resolution|comments|conversations|agent/i],
  ["customer", /description|question|customer|body|message|content|issue|text/i],
];

/** Recognizes the common help desk export shapes and proposes a field mapping. */
export function detectTickets(records: Obj[]): { shape: TicketShape; mapping: TicketMapping; fields: string[] } {
  const fields = fieldPaths(records);
  const pick = (...c: string[]) => c.find((f) => fields.includes(f)) ?? "";
  const like = (re: RegExp) => fields.find((f) => re.test(f)) ?? "";
  let shape: TicketShape = "generic", mapping: TicketMapping;
  if (pick("conversation_parts.conversation_parts", "source.body")) {
    shape = "intercom";
    mapping = { id: pick("id"), created: pick("created_at"), subject: pick("source.subject", "title"), customer: pick("source.body"), agent: pick("conversation_parts.conversation_parts"), status: pick("state"), tags: pick("tags.tags") };
  } else if (pick("fields.summary")) {
    shape = "jira";
    mapping = { id: pick("key", "id"), created: pick("fields.created"), subject: "fields.summary", customer: pick("fields.description"), agent: pick("fields.comment.comments"), status: pick("fields.status.name"), tags: pick("fields.labels") };
  } else if (like(/^ticket (id|name)$/i)) {
    shape = "hubspot";
    mapping = { id: like(/^ticket id$/i), created: like(/^create date$/i), subject: like(/^ticket name$/i), customer: like(/^ticket description$/i), agent: like(/^resolution$/i), status: like(/^ticket status$/i), tags: like(/^category$/i) };
  } else if (pick("description_text", "conversations", "fr_due_by", "responder_id")) {
    shape = "freshdesk";
    mapping = { id: pick("id"), created: pick("created_at"), subject: pick("subject"), customer: pick("description_text", "description"), agent: pick("conversations"), status: pick("status"), tags: pick("tags") };
  } else if (pick("requester_id", "submitter_id", "via.channel")) {
    shape = "zendesk";
    mapping = { id: pick("id"), created: pick("created_at"), subject: pick("subject", "raw_subject"), customer: pick("description"), agent: pick("comments"), status: pick("status"), tags: pick("tags") };
  } else {
    mapping = { id: "", created: "", subject: "", customer: "", agent: "", status: "", tags: "" };
    const used = new Set<string>();
    for (const [key, re] of GUESS) {
      const f = fields.find((x) => !used.has(x) && re.test(x.split(".").pop()!));
      if (f) { mapping[key] = f; used.add(f); }
    }
  }
  return { shape, mapping, fields };
}

// Atlassian Document Format (Jira Cloud rich text) to plain text.
const adf = (n: unknown): string => {
  if (!isObj(n)) return "";
  if (typeof n.text === "string") return n.text;
  if (n.type === "hardBreak") return "\n";
  if (isObj(n.attrs) && typeof n.attrs.text === "string") return n.attrs.text;
  return Array.isArray(n.content) ? n.content.map(adf).join(n.type === "paragraph" || n.type === "heading" ? "" : "\n") : "";
};
const TEXT_KEYS = ["plain_body", "body_text", "body", "html_body", "body_html", "text", "value", "content", "message", "description"];
function textOf(v: unknown, strip: (html: string) => string): string {
  if (typeof v === "string") return (/<\/?[a-z][^>]*>|&(#\d+|[a-z]+);/i.test(v) ? strip(v) : v).trim();
  if (typeof v === "number") return String(v);
  if (!isObj(v)) return "";
  if (v.type === "doc") return adf(v).trim();
  for (const k of TEXT_KEYS) if (v[k] != null && v[k] !== "") return textOf(v[k], strip);
  return "";
}

const CUSTOMER = /^(user|lead|contact|customer|end[-_ ]?user|requester|visitor|client)$/i;
const AGENT = /^(admin|agent|team|operator|staff|support|assistant|teammate)$/i;
const SYSTEM = /^(bot|system|automation|workflow)$/i;
function roleOf(c: Obj, requester: unknown): Turn["role"] {
  const author = isObj(c.author) ? c.author : isObj(c.from) ? c.from : {};
  const label = [c.role, author.type, author.role, c.author_type, c.sender_type].find((x): x is string => typeof x === "string") ?? "";
  if (CUSTOMER.test(label)) return "customer";
  if (AGENT.test(label)) return "agent";
  if (SYSTEM.test(label)) return "system";
  if (typeof c.incoming === "boolean") return c.incoming ? "customer" : "agent";
  const id = c.author_id ?? c.user_id ?? author.accountId ?? author.id;
  return id != null && requester != null && String(id) === String(requester) ? "customer" : "agent";
}
const isNote = (c: Obj) => c.public === false || c.private === true || c.jsdPublic === false || c.internal === true || c.part_type === "note";
const FRESHDESK_STATUS: Record<string, string> = { 2: "open", 3: "pending", 4: "resolved", 5: "closed" };

export type TicketOptions = { shape?: TicketShape; notes?: boolean; scrub?: boolean };

/** Applies a field mapping and emits one conversation per ticket. Internal notes are skipped unless asked. */
export function mapTickets(records: Obj[], map: TicketMapping, o: TicketOptions = {}, strip: (html: string) => string = htmlToText) {
  const conversations: Conversation[] = [], dates: string[] = [];
  let skipped = 0, chars = 0, customer = 0, agent = 0;
  records.forEach((r, i) => {
    const turns: Turn[] = [];
    let last = "";
    const push = (role: Turn["role"], time: string, text: string) => {
      if (!text || text === last) return; // the first comment often repeats the description
      last = text;
      turns.push({ role, time, text: clean(text, o.scrub) });
    };
    const created = toIso(getPath(r, map.created));
    push("customer", created, textOf(getPath(r, map.customer), strip));
    const requester = r.requester_id ?? getPath(r, "requester.id") ?? getPath(r, "fields.reporter.accountId") ?? getPath(r, "reporter.id") ?? r.customer_id ?? r.contact_id;
    const replies = getPath(r, map.agent);
    if (Array.isArray(replies)) {
      for (const c of replies) {
        if (!isObj(c)) { push("agent", "", textOf(c, strip)); continue; }
        if (isNote(c) && !o.notes) continue;
        push(isNote(c) ? "system" : roleOf(c, requester), toIso(c.created_at ?? c.created ?? c.createdAt ?? c.time ?? c.timestamp ?? c.updated_at), textOf(c, strip));
      }
    } else push("agent", "", textOf(replies, strip));
    if (!turns.length) { skipped++; return; }
    const status = getPath(r, map.status), tags = getPath(r, map.tags);
    const statusText = isObj(status) ? str(status.name) || str(status.label) : status == null ? "" : String(status);
    conversations.push({
      id: String(getPath(r, map.id) ?? i + 1), created,
      subject: clean(textOf(getPath(r, map.subject), strip), o.scrub),
      status: o.shape === "freshdesk" ? FRESHDESK_STATUS[statusText] ?? statusText : statusText,
      tags: (Array.isArray(tags) ? tags.map((t) => (isObj(t) ? str(t.name) || str(t.label) : String(t ?? ""))) : typeof tags === "string" ? tags.split(/[,;|]/) : []).map((t) => t.trim()).filter(Boolean),
      turns,
    });
    dates.push(created);
    for (const t of turns) { chars += t.text.length; if (t.role === "customer") customer++; else if (t.role === "agent") agent++; }
  });
  return { conversations, stats: { conversations: conversations.length, customer, agent, skipped, ...dateSpan(dates), tokens: approxTokens(chars) } };
}

// ---------- 4. Chat dataset formats ----------

export type ChatFormat = "openai" | "sharegpt" | "alpaca" | "pairs" | "conversation";
export const CHAT_FORMATS: { id: ChatFormat; label: string }[] = [
  { id: "openai", label: "OpenAI chat" }, { id: "sharegpt", label: "ShareGPT" }, { id: "alpaca", label: "Alpaca" },
  { id: "pairs", label: "Prompt / completion" }, { id: "conversation", label: "Conversation" },
];
export type ChatMessage = { role: string; content: string };

export function detectChatFormat(o: unknown): ChatFormat | null {
  if (!isObj(o)) return null;
  if (Array.isArray(o.conversations)) return "sharegpt";
  if (Array.isArray(o.turns)) return "conversation";
  if (Array.isArray(o.messages)) return isObj(o.messages[0]) && !("role" in o.messages[0]) && "text" in o.messages[0] ? "conversation" : "openai";
  if ("instruction" in o) return "alpaca";
  if ("prompt" in o || "question" in o) return "pairs";
  return null;
}

const content = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (isObj(p) ? str(p.text) : str(p))).join("") : v == null ? "" : String(v);
const SHAREGPT: Record<string, string> = { human: "user", user: "user", gpt: "assistant", assistant: "assistant", chatgpt: "assistant", bing: "assistant", bard: "assistant", system: "system" };
const list = (v: unknown) => (Array.isArray(v) ? v : []).filter(isObj);
const merge = (m: ChatMessage[]) => m.reduce<ChatMessage[]>((acc, x) => {
  const prev = acc[acc.length - 1];
  if (prev && prev.role === x.role) prev.content += "\n\n" + x.content; else acc.push({ ...x });
  return acc;
}, []);

function toMessages(o: Obj, f: ChatFormat): ChatMessage[] {
  const sys: ChatMessage[] = typeof o.system === "string" && o.system.trim() ? [{ role: "system", content: o.system }] : [];
  if (f === "openai") return list(o.messages).map((m) => ({ role: str(m.role), content: content(m.content) }));
  if (f === "sharegpt") return [...sys, ...list(o.conversations).map((m) => ({ role: SHAREGPT[str(m.from).toLowerCase()] ?? str(m.from), content: content(m.value) }))];
  if (f === "alpaca") return [...sys, { role: "user", content: [content(o.instruction), content(o.input)].filter((x) => x.trim()).join("\n\n") }, { role: "assistant", content: content(o.output) }];
  if (f === "pairs") return [...sys, { role: "user", content: content(o.prompt ?? o.question) }, { role: "assistant", content: content(o.completion ?? o.response ?? o.answer) }];
  // Conversation records from the ticket parser carry roles. Slack and email threads do not, so the
  // first speaker becomes the user and everyone else the assistant. Back-to-back turns are merged.
  if (Array.isArray(o.turns)) return merge(list(o.turns).filter((t) => t.role !== "system").map((t) => ({ role: t.role === "customer" ? "user" : t.role === "agent" ? "assistant" : str(t.role), content: content(t.text) })));
  const msgs = list(o.messages), first = msgs[0] ? str(msgs[0].user ?? msgs[0].from) : "";
  return merge(msgs.map((m) => ({ role: str(m.user ?? m.from) === first ? "user" : "assistant", content: content(m.text) })));
}

function fromMessages(m: ChatMessage[], f: ChatFormat, line: number): Obj | string {
  if (f === "openai") return { messages: m };
  if (f === "sharegpt") return { conversations: m.map((x) => ({ from: x.role === "user" ? "human" : x.role === "assistant" ? "gpt" : x.role, value: x.content })) };
  if (f === "conversation") return { id: `record-${line}`, created: "", subject: "", status: "", tags: [], turns: m.map((x) => ({ role: x.role === "user" ? "customer" : x.role === "assistant" ? "agent" : "system", time: "", text: x.content })) };
  const sys = m.filter((x) => x.role === "system").map((x) => x.content).join("\n\n"), turns = m.filter((x) => x.role !== "system");
  if (turns.length !== 2) return `Has ${turns.length} turns. The ${f === "alpaca" ? "Alpaca" : "prompt / completion"} format holds exactly one exchange.`;
  return f === "alpaca"
    ? { instruction: turns[0].content, input: "", output: turns[1].content, ...(sys ? { system: sys } : {}) }
    : { prompt: (sys ? sys + "\n\n" : "") + turns[0].content, completion: turns[1].content };
}

/** Structural problems that make a chat record unusable for fine-tuning. Empty array means valid. */
export function checkMessages(m: ChatMessage[], maxTokens = 8192): string[] {
  if (!m.length) return ["No messages found in this record."];
  const p: string[] = [];
  m.forEach((x, i) => {
    if (!x.role) p.push(`Message ${i + 1} has no role.`);
    else if (!["system", "user", "assistant"].includes(x.role)) p.push(`Message ${i + 1} has an unknown role "${x.role}".`);
    if (!x.content.trim()) p.push(`Message ${i + 1} has empty content.`);
    if (x.role === "system" && i > 0) p.push(`System message at position ${i + 1}. It must come first.`);
  });
  const turns = m.filter((x) => x.role !== "system");
  if (!turns.length) p.push("Only a system message. There is no user or assistant turn.");
  if (turns[0]?.role === "assistant") p.push("Wrong role order: the first turn is from the assistant, not the user.");
  if (turns.some((x, i) => i > 0 && x.role === turns[i - 1].role)) p.push("Turns do not alternate between user and assistant.");
  if (turns[turns.length - 1]?.role === "user") p.push("Wrong role order: the record ends on a user turn, so there is no assistant reply.");
  const tokens = approxTokens(m.reduce((n, x) => n + x.content.length, 0));
  if (tokens > maxTokens) p.push(`About ${tokens.toLocaleString("en-US")} tokens, over the ${maxTokens.toLocaleString("en-US")} limit.`);
  return p;
}

const BUCKETS: [string, number][] = [["under 250", 250], ["250 to 500", 500], ["500 to 1k", 1000], ["1k to 2k", 2000], ["2k to 4k", 4000], ["4k to 8k", 8000], ["8k and up", Infinity]];
export type ChatOptions = { from?: ChatFormat | "auto"; to: ChatFormat; maxTokens?: number };

/** Validates every record, converts the valid ones to `to`, and collects the rejects with reasons. */
export function convertChat(text: string, o: ChatOptions) {
  const t = text.trim();
  let items: { line: number; value?: unknown; raw?: string; error?: string }[] = [];
  let array: unknown;
  if (t[0] === "[") { try { array = JSON.parse(t); } catch { /* fall through to line mode */ } }
  if (Array.isArray(array)) items = array.map((value, i) => ({ line: i + 1, value }));
  else text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    try { items.push({ line: i + 1, value: JSON.parse(raw) }); } catch (e) { items.push({ line: i + 1, raw, error: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}` }); }
  });

  const valid: string[] = [], rejects: string[] = [], problems: { line: number; problems: string[] }[] = [];
  const roles: Record<string, number> = {}, formats: Partial<Record<ChatFormat, number>> = {};
  const histogram = BUCKETS.map(([label]) => ({ label, count: 0 }));
  let turns = 0, tokens = 0;
  for (const it of items) {
    let p: string[] = [], out: Obj | string = "";
    const f = o.from && o.from !== "auto" ? o.from : detectChatFormat(it.value);
    if (it.error) p = [it.error];
    else if (!isObj(it.value)) p = ["Not a JSON object."];
    else if (!f) p = ["Format not recognized. Expected one of these keys: messages, conversations, instruction, prompt or turns."];
    else {
      const m = toMessages(it.value, f);
      formats[f] = (formats[f] ?? 0) + 1;
      p = checkMessages(m, o.maxTokens);
      out = fromMessages(m, o.to, it.line);
      if (typeof out === "string" && m.length) p.push(out);
      const size = approxTokens(m.reduce((n, x) => n + x.content.length, 0));
      turns += m.length; tokens += size;
      for (const x of m) roles[x.role || "(none)"] = (roles[x.role || "(none)"] ?? 0) + 1;
      if (m.length) histogram[BUCKETS.findIndex(([, max]) => size < max)].count++;
    }
    if (p.length) { problems.push({ line: it.line, problems: p }); rejects.push(JSON.stringify({ line: it.line, problems: p, record: it.value ?? it.raw })); }
    else valid.push(JSON.stringify(out));
  }
  const join = (l: string[]) => l.join("\n") + (l.length ? "\n" : "");
  return { valid: join(valid), rejects: join(rejects), problems, stats: { records: items.length, valid: valid.length, rejected: rejects.length, turns, tokens, roles, formats, histogram } };
}

// ---------- 5. Logs ----------

export type LogFormat = "json" | "combined" | "syslog" | "iso" | "logfmt" | "custom";
export const LOG_FORMATS: { id: Exclude<LogFormat, "custom">; label: string }[] = [
  { id: "json", label: "JSON lines" }, { id: "combined", label: "Apache / Nginx" }, { id: "syslog", label: "Syslog" },
  { id: "iso", label: "Timestamp + level" }, { id: "logfmt", label: "logfmt" },
];

const flat = (o: Obj, pre = "", out: Row = {}): Row => {
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v)) flat(v, `${pre}${k}.`, out);
    else out[pre + k] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
};
const named = (re: RegExp) => (l: string): Row | null => {
  const g = re.exec(l)?.groups;
  return g ? Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v ?? ""])) : null;
};
const COMBINED = named(/^(?<ip>\S+) \S+ (?<user>\S+) \[(?<time>[^\]]+)\] "(?<method>[A-Z]+) (?<path>\S+)(?: (?<protocol>[^"]*))?" (?<status>\d{3}) (?<bytes>\d+|-)(?: "(?<referer>[^"]*)" "(?<user_agent>[^"]*)")?/);
const SYSLOG_3164 = named(/^(?:<(?<priority>\d+)>)?(?<time>[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}) (?<host>\S+) (?<app>[^\s:[]+)(?:\[(?<pid>\d+)\])?: ?(?<message>.*)$/);
const SYSLOG_5424 = named(/^<(?<priority>\d+)>\d (?<time>\S+) (?<host>\S+) (?<app>\S+) (?<pid>\S+) (?<msgid>\S+) (?:-|\[.*?\]) ?(?<message>.*)$/);
const ISO = named(/^\[?(?<time>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+\[?(?<level>TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRIT(?:ICAL)?)\]?[\s:-]*(?<message>.*)$/i);

const LINE: Record<Exclude<LogFormat, "custom">, (l: string) => Row | null> = {
  json: (l) => { if (l[0] !== "{") return null; try { const v: unknown = JSON.parse(l); return isObj(v) ? flat(v) : null; } catch { return null; } },
  combined: (l) => {
    const r = COMBINED(l);
    if (r) { const d = new Date(r.time.replace(/\//g, " ").replace(":", " ")); if (!Number.isNaN(d.getTime())) r.time = d.toISOString(); }
    return r;
  },
  syslog: (l) => SYSLOG_5424(l) ?? SYSLOG_3164(l),
  iso: (l) => ISO(l),
  logfmt: (l) => {
    const row: Row = {};
    let n = 0, covered = 0;
    for (const m of l.matchAll(/([\w.\-/]+)=("(?:[^"\\]|\\.)*"|\S*)/g)) {
      row[m[1]] = m[2][0] === '"' ? m[2].slice(1, -1).replace(/\\(.)/g, "$1") : m[2];
      n++; covered += m[0].length;
    }
    return n >= 2 && covered >= l.trim().length * 0.6 ? row : null;
  },
};

/** Picks the format that parses at least half of the first 100 non-empty lines, or null. */
export function detectLogFormat(lines: string[]): Exclude<LogFormat, "custom"> | null {
  const sample = lines.filter((l) => l.trim()).slice(0, 100);
  let best: Exclude<LogFormat, "custom"> | null = null, top = 0;
  for (const { id } of LOG_FORMATS) {
    const n = sample.filter((l) => LINE[id](l.trim())).length;
    if (n > top) { top = n; best = id; }
  }
  return top && top >= sample.length / 2 ? best : null;
}

/** Validates a custom pattern: it must compile and contain at least one named group. */
export function compileLogRegex(src: string): { re?: RegExp; error: string } {
  if (!src.trim()) return { error: "Enter a pattern with named groups, for example (?<level>\\w+)." };
  try {
    const re = new RegExp(src);
    return /\(\?<[A-Za-z_$][\w$]*>/.test(src) ? { re, error: "" } : { error: "Add at least one named group, for example (?<level>\\w+). Group names become field names." };
  } catch (e) { return { error: `Pattern does not compile: ${e instanceof Error ? e.message : "invalid regular expression"}` }; }
}

export type LogOptions = { format?: LogFormat | "auto"; regex?: string; drop?: string[]; mask?: boolean };
const maskValue = (v: string) => (/@|\d\.\d/.test(v) ? scrub(v, { types: ["IP", "EMAIL"], numbered: false }).text : v);

export function parseLogs(text: string, o: LogOptions = {}) {
  const lines = text.split(/\r?\n/);
  const empty = { format: null as LogFormat | null, rows: [] as Row[], fields: [] as string[], unparsed: [] as { line: number; text: string }[], unparsedCount: 0, error: "" };
  if (!text.trim()) return empty;
  let format: LogFormat | null = o.format && o.format !== "auto" ? o.format : detectLogFormat(lines);
  let parse: (l: string) => Row | null;
  if (format === "custom") {
    const c = compileLogRegex(o.regex ?? "");
    if (!c.re) return { ...empty, format, error: c.error };
    parse = named(c.re);
  } else if (format) parse = LINE[format];
  else return { ...empty, error: "Format not recognized. Pick a format above, or write a custom pattern with named groups." };

  const rows: Row[] = [], unparsed: { line: number; text: string }[] = [];
  let unparsedCount = 0;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const row = parse(raw.trim());
    if (row) rows.push(row);
    else if (format === "iso" && rows.length) rows[rows.length - 1].message += "\n" + raw; // stack trace or wrapped line
    else { unparsedCount++; if (unparsed.length < 50) unparsed.push({ line: i + 1, text: raw.slice(0, 300) }); }
  });
  if (!rows.length) return { ...empty, format, unparsed, unparsedCount, error: "No lines matched this format. Pick another format, or write a custom pattern with named groups." };
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const drop = new Set(o.drop ?? []);
  const out = drop.size || o.mask
    ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k)).map(([k, v]) => [k, o.mask ? maskValue(v) : v])))
    : rows;
  return { format, rows: out, fields, unparsed, unparsedCount, error: "" };
}

// ---------- 6. Document text ----------

export type Doc = { file: string; title: string; text: string; words: number };

const mdToText = (md: string) => md
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
  .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/^#{1,6}\s+/gm, "").replace(/^[ \t]*>[ \t]?/gm, "")
  .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, "")
  .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
  .replace(/(\*\*|__|\*|~~|`)(\S(?:.*?\S)?)\1/g, "$2")
  .replace(/<[^>]+>/g, "");
const xmlToText = (xml: string) => decodeEntities(xml
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
  .replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>/g, " ")
  .replace(/<[^>]+>/g, "\n"));
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") { if (v.trim()) out.push(v.trim()); }
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => strings(x, out));
  return out;
};

/** Readable text from an .html, .md, .txt, .xml or .json file. Throws a readable message otherwise. */
export function extractText(name: string, raw: string, html: (h: string) => { title: string; text: string } = (h) => ({ title: htmlTitle(h), text: htmlToText(h) })): Doc {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const base = name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  let title = "", text: string;
  if (ext === "html" || ext === "htm" || ext === "xhtml") ({ title, text } = html(raw));
  else if (ext === "md" || ext === "markdown") { title = /^#\s+(.+)$/m.exec(raw)?.[1].trim() ?? ""; text = mdToText(raw); }
  else if (ext === "txt" || ext === "text") text = raw;
  else if (ext === "xml") { title = decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1] ?? "").trim(); text = xmlToText(raw); }
  else if (ext === "json") {
    let v: unknown;
    try { v = JSON.parse(raw); } catch { throw new Error(`${name} is not valid JSON.`); }
    title = isObj(v) ? str(v.title) || str(v.name) : "";
    text = strings(v).join("\n");
  } else if (ext === "pdf" || ext === "docx" || ext === "doc") throw new Error(`${name}: PDF and Word files are not supported. Export the document as HTML or plain text first.`);
  else throw new Error(`${name}: unsupported file type. This tool reads .html, .md, .txt, .xml and .json.`);
  text = tidy(text);
  return { file: name, title: title || base, text, words: (text.match(/\S+/g) ?? []).length };
}
