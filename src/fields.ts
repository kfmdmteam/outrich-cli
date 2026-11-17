// Field rules: what to do with a value, decided from where it sits in the record. A policy file
// (from `outrich plan`) names the action per field path; fields it does not list fall back to keyRule().
import { createHash } from "node:crypto";
import type { PiiType } from "./lib/pii.ts";

/** keep: untouched. scrub: the whole value is replaced as `type`. text: the detectors run inside the value. hash: stable token. drop: field removed. */
export type Action = "keep" | "scrub" | "drop" | "hash" | "text";
/** `contextual`: the key is the bare word "name"; nameContext() has the last word. */
export type Rule = { action: Action; type?: PiiType; person?: boolean; contextual?: boolean };
export type Policy = Record<string, Rule>;

const set = (s: string) => new Set(s.split(" "));
const PERSON_ROLE = set("owner contact customer client recipient sender engineer assignee author agent employee patient tenant landlord buyer seller applicant member subscriber requester reporter inspector technician manager supervisor attorney");
const NAME_WORD = set("name firstname lastname fullname surname forename middlename nickname fname lname");
const ORG = set("company business org organization organisation firm vendor employer supplier merchant");
const NOT_A_PERSON = set("file product plan event field column table brand item sku category project host domain type status tag key class function method index db database bucket queue topic template role group color font country state county region app application service device model schema path dir folder repo branch table label step stage job task rule policy channel");
const TYPED: [PiiType, Set<string>][] = [
  ["PHONE", set("phone mobile cell cellphone fax tel telephone whatsapp")],
  ["SSN", set("ssn")], ["TAX_ID", set("ein fein itin tin taxid")], ["DOB", set("dob birth birthday birthdate born")],
  ["PASSPORT", set("passport")], ["IBAN", set("iban")], ["CARD", set("creditcard cardnumber")],
  ["BANK", set("routing aba acct")], ["SECRET", set("password passwd pwd secret token apikey")],
];

/** The words of a key: ownerName, owner_name and "Owner Name" all give ["owner", "name"]. */
export const keyWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// A plural counts as its singular: "phones" is a phone field, "clients" holds clients.
const withSingulars = (w: string[]) => w.flatMap((x) => (x.length > 3 && x.endsWith("s") ? [x, x.slice(0, -1)] : [x]));

const PERSON_PARENT = set("client customer contact owner user person people employee tenant member patient author assignee agent recipient sender lead staff engineer inspector technician landlord buyer seller applicant subscriber requester reporter manager attorney driver student teacher guest visitor donor volunteer candidate");
const THING_PARENT = set("item line lineitem product service template table file attachment plan category project sku document doc report invoice order tag label role group team company org organization business vendor account workspace channel repo device model schema setting config field column status type event task job step stage list folder");
const THING_SIBLING = set("price quantity qty sku unit mime mimetype size amount cost rate total subtotal url path extension ext width height duration bytes checksum");
const nameCache = new Map<string, { person: boolean | null; reason: string }>();
/**
 * A field called just "name" can hold a person or a thing. Where it sits decides:
 * the nearest enclosing field (then the file) that names a person or a thing wins, then the fields beside it.
 * person null means nothing decided it; the value then goes to the free-text detectors under its own key.
 */
export function nameContext(parentPath: string, siblings: string[], source: string): { person: boolean | null; reason: string } {
  const id = `${parentPath}\u0000${source}\u0000${siblings.join("\u0001")}`;
  let r = nameCache.get(id);
  if (r) return r;
  r = { person: null, reason: "name: nothing around it says person or thing, so the detectors decide" };
  const levels = [...parentPath.split(".").filter(Boolean).reverse().map((s) => [s, "under"]), ...source.replace(/\.[a-z0-9.]+$/i, "").split(/[\\/]/).filter((s) => s && !/^documents?$/i.test(s)).reverse().map((s) => [s, "in file"])];
  for (const [seg, how] of levels) {
    const w = withSingulars(keyWords(seg));
    if (w.some((x) => PERSON_PARENT.has(x))) { r = { person: true, reason: `name ${how} "${seg.replace(/\[\]/g, "")}": a person` }; break; }
    if (w.some((x) => THING_PARENT.has(x) || NOT_A_PERSON.has(x))) { r = { person: false, reason: `name ${how} "${seg.replace(/\[\]/g, "")}": a thing, read as free text` }; break; }
  }
  if (r.person === null) {
    const thing = siblings.find((k) => keyWords(k).some((x) => THING_SIBLING.has(x)));
    const contact = siblings.find((k) => { const t = keyRule(k); return t.action === "scrub" && (t.type === "EMAIL" || t.type === "PHONE" || t.type === "ADDRESS") ; });
    if (thing) r = { person: false, reason: `name beside "${thing}": a thing, read as free text` };
    else if (contact) r = { person: true, reason: `name beside "${contact}": a person` };
  }
  if (nameCache.size < 50_000) nameCache.set(id, r);
  return r;
}

const cache = new Map<string, Rule>();
/** The default rule for a field, from its name alone. */
export function keyRule(key: string): Rule {
  let r = cache.get(key);
  if (!r) { r = decide(withSingulars(keyWords(key)), keyWords(key)); if (cache.size < 50_000) cache.set(key, r); }
  return r;
}
function decide(w: string[], exact: string[]): Rule {
  const has = (x: string) => w.includes(x);
  const scrub = (type: PiiType, person = false): Rule => ({ action: "scrub", type, ...(person ? { person } : {}) });
  if (has("email") || (has("e") && has("mail"))) return scrub("EMAIL");
  if (has("ip") && (w.length === 1 || has("address") || has("addr"))) return scrub("IP");
  if (has("mac") && (has("address") || has("addr"))) return scrub("MAC");
  for (const [type, words] of TYPED) if (w.some((x) => words.has(x))) return scrub(type);
  if ((has("license") || has("licence") || has("dl")) && w.some((x) => /^(driver|drivers|driving|dl|number|num|no|id)$/.test(x))) return scrub("LICENSE");
  if (has("social") && has("security")) return scrub("SSN");
  if (has("tax") && (has("id") || has("number"))) return scrub("TAX_ID");
  if (has("card") && (has("number") || has("num") || has("no"))) return scrub("CARD");
  if (has("account") && (has("number") || has("num") || has("no")) || (has("bank") && has("account"))) return scrub("BANK");
  if (has("api") && has("key")) return scrub("SECRET");
  if (has("username") || has("login") || (has("user") && has("name"))) return scrub("ID");
  if (w.some((x) => /^(address|addr|street|zip|zipcode|postcode|postal)$/.test(x))) return scrub("ADDRESS");
  if (w.some((x) => NAME_WORD.has(x))) {
    if (w.some((x) => ORG.has(x))) return scrub("NAME");
    if (exact.length === 1 && exact[0] === "name") return { action: "scrub", type: "NAME", person: true, contextual: true };
    if (!w.some((x) => NOT_A_PERSON.has(x) || THING_PARENT.has(x))) return scrub("NAME", true);
  } else if (PERSON_ROLE.has(exact[exact.length - 1] ?? "") && exact.length <= 2) return scrub("NAME", true);
  return { action: "text" };
}

/**
 * Whether a whole value may be replaced as `type`. A name field is replaced whole whatever it holds: one person,
 * several owners, a company, a company named after an address. Only a value too long to be a name goes to the detectors.
 */
export const wholeValueOk = (_rule: Rule, value: string) => value.length <= 200;

/** A value that reads as an organization or a place. It is replaced like any other name, but its words are not learned as a person's. */
export const NOT_A_PERSON_VALUE = /\d|\b(?:llc|l\.l\.c|inc|corp|co|ltd|lp|llp|trust|estate|associates|assoc|realty|properties|holdings|management|group|company|bank|church|city|county|township|authority|partners|enterprises|ventures|investments|development|construction|services)\b/i;

export const POLICY_VERSION = 1;
export type PolicyFile = {
  version: 1; tool: "outrich"; created: string; sampledRecords: number;
  fields: { path: string; action: Action; type?: PiiType; coverage: number; detected: Record<string, number>; sample: string; /** Why this action was suggested. Not read back. */ reason?: string }[];
};

/** Reads and checks a policy file. Returns the rules by path and the hash that reports record. */
export function loadPolicy(text: string): { policy: Policy; hash: string } {
  let p: PolicyFile;
  try { p = JSON.parse(text); } catch { throw new Error("The policy file is not valid JSON."); }
  if (!p || p.version !== POLICY_VERSION || !Array.isArray(p.fields)) throw new Error("This is not an outrich policy file (version 1).");
  const policy: Policy = {};
  for (const f of p.fields) {
    if (typeof f.path !== "string" || !["keep", "scrub", "drop", "hash", "text"].includes(f.action)) throw new Error(`Policy entry for "${f?.path}" needs a path and an action of keep, scrub, drop, hash or text.`);
    if (f.action === "scrub" && !f.type) throw new Error(`Policy entry for "${f.path}" has action scrub but no type.`);
    policy[f.path] = { action: f.action, ...(f.type ? { type: f.type } : {}), ...(f.action === "scrub" && f.type === "NAME" && keyRule(f.path.split(".").pop()!.replace(/\[\]$/, "")).person ? { person: true } : {}) };
  }
  return { policy, hash: policyHash(policy) };
}
/** SHA-256 over the sorted [path, action, type] list: the same rules give the same hash, whatever else the file says. */
export const policyHash = (policy: Policy) =>
  createHash("sha256").update(JSON.stringify(Object.keys(policy).sort().map((k) => [k, policy[k].action, policy[k].type ?? ""]))).digest("hex");

/** The shape of a value with every letter and digit hidden: "Dana Lee 42" gives "Aaaa Aaa 99". */
export const shape = (v: string) => v.slice(0, 40).replace(/\p{L}|\d/gu, (c) => (c >= "0" && c <= "9" ? "9" : c === c.toLowerCase() ? "a" : "A"));
