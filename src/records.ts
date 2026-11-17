// What happens to one record. Each record is handled on its own: nothing learned in one record is
// used in another, so results do not depend on worker count or block boundaries.
import { createScrubber, addCounts, hashValue, type Counts, type PiiType, type ScrubOptions } from "./lib/pii.ts";
import { keyRule, nameContext, NOT_A_PERSON_VALUE, shape, wholeValueOk, type Policy, type Rule } from "./fields.ts";

export type WorkerOptions = ScrubOptions & { policy?: Policy; strict?: boolean };
export type FieldPlan = { n: number; numeric: number; text: number; whole: number; types: Record<string, number>; sample: string; /** How often each rule and reason applied to this path. */ why: Record<string, number> };
export type Residual = Record<string, Record<string, { n: number; samples: string[] }>>;
export type Tally = {
  records: number; replacements: number; counts: Counts; rules: Record<string, number>;
  invalidJson: number; oversized: number; chars: number; fields: Record<string, number>;
  /** Replacements per field path and type. "TEXT" counts values the detectors changed inside free text. */
  byField: Record<string, Record<string, number>>;
  unknown: string[]; plan: Record<string, FieldPlan>; residual: Residual;
};

export const newTally = (): Tally => ({ records: 0, replacements: 0, counts: {}, rules: {}, invalidJson: 0, oversized: 0, chars: 0, fields: {}, byField: {}, unknown: [], plan: {}, residual: {} });
const MAX_PATHS = 5000; // ponytail: per-field tables stop growing here; data with more distinct field paths than this needs a policy with fewer, wider rules
const room = (o: object, k: string) => Object.hasOwn(o, k) || Object.keys(o).length < MAX_PATHS;
export function bump(o: Record<string, number>, k: string, n = 1) { if (room(o, k)) o[k] = (o[k] ?? 0) + n; }
const bump2 = (o: Record<string, Record<string, number>>, a: string, b: string, n = 1) => { if (room(o, a)) bump((o[a] ??= {}), b, n); };

export function addTally(into: Tally, from: Tally) {
  into.records += from.records; into.replacements += from.replacements; into.invalidJson += from.invalidJson;
  into.oversized += from.oversized; into.chars += from.chars;
  addCounts(into.counts, from.counts); addCounts(into.rules, from.rules);
  for (const k in from.fields) bump(into.fields, k, from.fields[k]);
  for (const p in from.byField) for (const k in from.byField[p]) bump2(into.byField, p, k, from.byField[p][k]);
  for (const u of from.unknown ?? []) if (into.unknown.length < 50 && !into.unknown.includes(u)) into.unknown.push(u);
  for (const p in from.plan) {
    const a = from.plan[p];
    if (!room(into.plan, p)) continue;
    const b = (into.plan[p] ??= { n: 0, numeric: 0, text: 0, whole: 0, types: {}, sample: "", why: {} });
    b.n += a.n; b.numeric += a.numeric; b.text += a.text; b.whole += a.whole; b.sample ||= a.sample;
    addCounts(b.types, a.types); addCounts(b.why, a.why);
  }
  for (const p in from.residual) for (const k in from.residual[p]) {
    if (!room(into.residual, p)) continue;
    const a = from.residual[p][k], b = ((into.residual[p] ??= {})[k] ??= { n: 0, samples: [] });
    b.n += a.n;
    for (const s of a.samples) if (b.samples.length < 3 && !b.samples.includes(s)) b.samples.push(s);
  }
  return into;
}

const SEP = "\n␞\n"; // joins the free-text values of one record into one scrub call; no detector can match across it
const TOKEN = /\[[A-Z][A-Z0-9_]*(?:_[0-9a-f]+)?\]/g; // what label and hash modes write
const MASKED = /\S*\*{2,}\S*/g; // what mask mode writes
/** The four types an audit fails on by default. */
export const GATED: PiiType[] = ["EMAIL", "PHONE", "SSN", "CARD"];

const NONE: string[] = [];
// A value that reads as an organization or a place is replaced like any other name, but its words are not learned as a person's.

/** The scalar values of a record, in document order, with where each one sits. */
class Leaves {
  path: string[] = []; key: string[] = []; value: string[] = []; num: boolean[] = [];
  box: (Record<string, unknown> | unknown[])[] = []; at: (string | number)[] = [];
  parent: string[] = []; beside: string[][] = [];
  changed = false;
  constructor(private dropped: (path: string) => boolean) {}
  add(box: Record<string, unknown> | unknown[], at: string | number, v: unknown, path: string, key: string, parent = "", beside: string[] = NONE) {
    if (typeof v === "string") { if (v) this.push(box, at, v, false, path, key, parent, beside); }
    else if (typeof v === "number") this.push(box, at, String(v), true, path, key, parent, beside);
    else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) this.add(v, i, v[i], path + "[]", key, parent, beside);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>, keys = Object.keys(o);
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (this.dropped(p)) { delete o[k]; this.changed = true; } else this.add(o, k, o[k], p, k, path, keys);
      }
    }
  }
  private push(box: Record<string, unknown> | unknown[], at: string | number, v: string, num: boolean, path: string, key: string, parent: string, beside: string[]) {
    this.box.push(box); this.at.push(at); this.value.push(v); this.num.push(num); this.path.push(path); this.key.push(key); this.parent.push(parent); this.beside.push(beside);
  }
  set(i: number, v: unknown) { (this.box[i] as Record<string | number, unknown>)[this.at[i]] = v; this.changed = true; }
}

export function createRecords(options: WorkerOptions) {
  const s = createScrubber({ ...options, findings: false });
  const policy = options.policy;
  const rules = new Map<string, Rule | null>();
  const dropped = (path: string) => policy?.[path]?.action === "drop";
  function ruleFor(path: string, key: string, t: Tally): Rule {
    let r = rules.get(path);
    if (r === undefined) { r = policy?.[path] ?? (policy && options.strict ? null : keyRule(key)); if (rules.size < 100_000) rules.set(path, r); }
    if (r) return r;
    if (t.unknown.length < 20 && !t.unknown.includes(path)) t.unknown.push(path);
    return keyRule(key);
  }
  let source = ""; // the file being read: its name is context for a field called just "name"
  const FREE: Rule = { action: "text" };
  /** The rule for one value, the field name to show the detectors, and why. A policy entry always wins. */
  function decide(l: Leaves, i: number, t: Tally): { rule: Rule; key: string; why: string } {
    const path = l.path[i], key = l.key[i], listed = policy?.[path], base = ruleFor(path, key, t);
    if (keyRule(key).contextual) {
      // "name" alone: a person under clients or beside an email, a thing under lineItems or beside a price.
      // As a thing it is shown to the detectors without its key, because the key "name" by itself makes any capitalized words look like a person.
      if (listed) return { rule: base, key: base.action === "text" ? "" : key, why: "policy" };
      const c = nameContext(l.parent[i], l.beside[i], source);
      return c.person ? { rule: base, key, why: c.reason } : { rule: FREE, key: c.person === false ? "" : key, why: c.reason };
    }
    return { rule: base, key, why: listed ? "policy" : base.action === "scrub" ? `field name says ${base.type}` : "free text: the detectors decide" };
  }
  const took = (t: Tally, r: { total: number; counts: Counts; rules: Record<string, number> }) => { t.replacements += r.total; addCounts(t.counts, r.counts); addCounts(t.rules, r.rules); };

  /** One line of plain text, or a piece of a record too long to parse. */
  function text(value: string, t: Tally): string {
    if (!value) return value;
    s.reset();
    const r = s.scrub(value);
    if (!r.total) return value;
    took(t, r); bump2(t.byField, "(text)", "TEXT");
    return r.text;
  }

  // Runs the detectors over the free-text values of one record in a single call. Each value is shown as
  // `"field": "value"`, the shape the detectors know from raw JSON, so the field name counts as context.
  function scrubValues(keys: string[], values: string[], t: Tally): string[] | null {
    const prefixes = keys.map((k) => `"${k}": "`);
    const r = s.scrub(values.map((v, i) => `${prefixes[i]}${v}"`).join(SEP));
    if (!r.total) return null;
    const parts = r.text.split(SEP);
    if (parts.length === values.length && parts.every((p, i) => p.startsWith(prefixes[i]) && p.endsWith('"'))) {
      took(t, r);
      return parts.map((p, i) => p.slice(prefixes[i].length, -1));
    }
    // A match reached outside its value. Redo the record value by value, without the field names.
    return values.map((v) => { const one = s.scrub(v); took(t, one); return one.text; });
  }

  /** Applies the field rules to one record's values. Whole-value fields go first so the names they hold are known when the free text is read. */
  function scrubLeaves(l: Leaves, t: Tally) {
    s.reset();
    const free: number[] = [], keys: string[] = [];
    for (let i = 0; i < l.value.length; i++) {
      const { rule, key } = decide(l, i, t), v = l.value[i];
      if (rule.action === "keep") continue;
      if (rule.action === "hash") { l.set(i, hashValue(v, options.salt)); t.replacements++; bump2(t.byField, l.path[i], "HASH"); bump(t.rules, "field-hash"); }
      else if (rule.action === "scrub" && wholeValueOk(rule, v)) {
        const type = rule.type!;
        l.set(i, s.replace(type, v));
        if (rule.person && !NOT_A_PERSON_VALUE.test(v)) s.learn(v);
        t.replacements++; bump(t.counts as Record<string, number>, type); bump(t.rules, "field-name"); bump2(t.byField, l.path[i], type);
      } else { free.push(i); keys.push(key); }
    }
    if (!free.length) return;
    const values = free.map((i) => l.value[i]);
    const cleaned = scrubValues(keys, values, t);
    if (cleaned) free.forEach((i, k) => { if (cleaned[k] !== values[k]) { l.set(i, cleaned[k]); bump2(t.byField, l.path[i], "TEXT"); } });
  }

  function parse(line: string, t: Tally): { value: unknown; leaves: Leaves } | null {
    let value: unknown;
    // Not valid JSON, or (below) holding a number too large to survive a rewrite: handled as plain text.
    try { value = JSON.parse(line); } catch { t.invalidJson++; return null; }
    const leaves = new Leaves(dropped), root = [value];
    leaves.add(root, 0, value, "", "");
    for (let i = 0; i < leaves.value.length; i++) if (leaves.num[i]) { const n = +leaves.value[i]; if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) { t.invalidJson++; return null; } }
    return { get value() { return root[0]; }, leaves };
  }

  function jsonLine(line: string, t: Tally): string {
    const p = parse(line, t);
    if (!p) return text(line, t);
    scrubLeaves(p.leaves, t);
    return p.leaves.changed ? JSON.stringify(p.value) : line; // nothing changed: keep the original bytes
  }

  /** Returns the cleaned row, without the cells of dropped columns. */
  function csvRow(row: string[], header: string[], t: Tally): string[] {
    const out = row.slice(), l = new Leaves(dropped);
    const name = (i: number) => header[i] ?? `column_${i + 1}`;
    row.forEach((v, i) => { if (v && !dropped(name(i))) l.add(out, i, v, name(i), name(i), "", header); });
    if (l.value.length) scrubLeaves(l, t);
    return policy ? out.filter((_, i) => !dropped(name(i))) : out;
  }

  // Shared by plan, audit and profile: the values of a record without changing it.
  function read(fmt: "jsonl" | "csv" | "text", item: string | string[], header: string[], t: Tally): Leaves | null {
    if (fmt === "csv") {
      const l = new Leaves(() => false), row = item as string[];
      row.forEach((v, i) => l.add(row, i, v, header[i] ?? `column_${i + 1}`, header[i] ?? `column_${i + 1}`, "", header));
      return l;
    }
    if (fmt === "jsonl") { const p = parse(item as string, t); if (p) return p.leaves; }
    const l = new Leaves(() => false);
    l.add([item], 0, item, "(text)", "");
    return l;
  }

  /** profile: field coverage and personal data counts. */
  function profile(l: Leaves, t: Tally) {
    const seen = new Set<string>();
    for (const p of l.path) { const top = p.split(/[.[]/, 1)[0]; if (!seen.has(top)) { seen.add(top); bump(t.fields, top); } }
    s.reset();
    if (l.value.length) took(t, s.scrub(l.value.map((v, i) => `"${l.key[i]}": "${v}"`).join(SEP)));
  }

  /** plan: what each field path holds, from a sample. */
  function plan(l: Leaves, t: Tally) {
    for (let i = 0; i < l.value.length; i++) {
      const v = l.value[i], path = l.path[i];
      if (!room(t.plan, path)) continue;
      const f = (t.plan[path] ??= { n: 0, numeric: 0, text: 0, whole: 0, types: {}, sample: "", why: {} });
      const d = decide(l, i, t);
      bump(f.why, `${d.rule.action === "scrub" ? d.rule.type : ""}|${d.why}`);
      f.n++; f.sample ||= shape(v);
      if (l.num[i]) f.numeric++;
      if (/\s/.test(v)) f.text++;
      s.reset();
      const prefix = `"${d.key}": "`, r = s.scrub(`${prefix}${v}"`);
      for (const type in r.counts) bump(f.types, type);
      if (r.total === 1 && r.text.replace(TOKEN, "").length <= prefix.length + 1) f.whole++;
    }
  }

  /** audit: what in an already scrubbed record still looks like personal data. Samples keep the shape only. */
  function audit(l: Leaves, t: Tally) {
    const note = (path: string, type: string, sample: string, n = 1) => {
      if (!room(t.residual, path)) return;
      const r = ((t.residual[path] ??= {})[type] ??= { n: 0, samples: [] });
      r.n += n;
      const sh = shape(sample.trim());
      if (r.samples.length < 3 && !r.samples.includes(sh)) r.samples.push(sh);
    };
    for (let i = 0; i < l.value.length; i++) {
      const path = l.path[i], left = l.value[i].replace(TOKEN, " ").replace(MASKED, " ");
      if (!/[\p{L}\p{N}]{2}/u.test(left) || /^[0-9a-f]{16}$/.test(left)) continue; // only tokens, masks or a hash remain
      const { rule, key } = decide(l, i, t);
      const byKey = rule.action === "scrub" && !l.value[i].includes("**") && wholeValueOk(rule, left) && !(rule.type !== "NAME" && rule.type !== "ADDRESS" && !/\d/.test(left)) ? rule.type! : "";
      if (byKey) note(path, byKey, left);
      s.reset();
      const r = s.scrub(`"${key}": "${left}"`);
      for (const type in r.counts) if (type !== byKey) note(path, type, left, r.counts[type as PiiType]);
    }
  }

  return { text, jsonLine, csvRow, read, profile, plan, audit, from(file: string) { source = file; } };
}
