// Field-aware scrubbing, plan, audit, detector fixes, mail and zip input, and `run`.
// All data here is synthetic. It imitates the shapes that real exports have; no real value is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { run, tmp, write, read } from "./helpers.mjs";
import { createScrubber, createWorker, keyRule } from "../dist/outrich.mjs";
import { property, ticket } from "../scripts/gen.mjs";

const enc = new TextEncoder(), dec = new TextDecoder();
const scrubJson = (obj, options = {}) => JSON.parse(dec.decode(createWorker(options)({ kind: "scrub", fmt: "jsonl", bytes: enc.encode(JSON.stringify(obj) + "\n"), raw: false, endsLine: true }).out));
const clean = (text, options = {}) => createScrubber(options).scrub(text).text;
const props = (n) => Array.from({ length: n }, (_, i) => property(i).line + "\n").join("");

/* ---------------------------------------------------------------- A. fields */

test("field names decide: ownerName, address, addressKey, ownerPhone, nested client names and company names are replaced whole", () => {
  for (let i = 0; i < 300; i++) {
    const p = property(i), out = scrubJson(p.record), text = JSON.stringify(out);
    assert.match(out.ownerName, /^\[NAME_\d+\]$/);
    assert.match(out.ownerPhone, /^\[PHONE_\d+\]$/);
    assert.match(out.ownerEmail, /^\[EMAIL_\d+\]$/);
    assert.match(out.address, /^\[ADDRESS_\d+\]$/);
    assert.match(out.addressKey, /^\[ADDRESS_\d+\]$/);
    for (const k of ["companyName", "contactName", "engineerName"]) assert.match(out[k], /^\[NAME_\d+\]$/, k);
    assert.ok(out.clients.every((c) => /^\[NAME_\d+\]$/.test(c.name)));
    assert.deepEqual([out._id, out._creationTime, out.status, out.units, out.clients[0].role], [p.record._id, p.record._creationTime, p.record.status, p.record.units, "owner"]);
    // The same people and places are gone from the free text too, uncommon names and upper-case addresses included.
    for (const v of [p.first, p.last, p.address, p.email, p.engineer.split(" ")[1]]) assert.ok(!text.toLowerCase().includes(v.toLowerCase()), `record ${i} still holds ${JSON.stringify(v)}: ${out.notes}`);
    assert.ok(!/\d{3}[ .-]+555/.test(text), `record ${i} still holds a phone: ${out.notes}`);
    assert.equal(out.clients[1].name, out.contactName, "the same value gets the same label across fields");
  }
});

test("key rules: what a field name means", () => {
  const type = (k) => { const r = keyRule(k); return r.action === "scrub" ? r.type : r.action; };
  const want = {
    ownerName: "NAME", owner_name: "NAME", "Owner Name": "NAME", name: "NAME", firstName: "NAME", last_name: "NAME", fullName: "NAME", contactName: "NAME", companyName: "NAME", engineerName: "NAME",
    customer: "NAME", recipient: "NAME", sender: "NAME", address: "ADDRESS", addressKey: "ADDRESS", streetAddress: "ADDRESS", addr: "ADDRESS", zip: "ADDRESS", postal_code: "ADDRESS",
    ownerPhone: "PHONE", mobile: "PHONE", cell: "PHONE", fax: "PHONE", tel: "PHONE", email: "EMAIL", emailAddress: "EMAIL", ownerEmail: "EMAIL", ipAddress: "IP",
    ssn: "SSN", taxId: "TAX_ID", ein: "TAX_ID", dob: "DOB", birthDate: "DOB", driverLicense: "LICENSE", passportNumber: "PASSPORT", cardNumber: "CARD", iban: "IBAN", accountNumber: "BANK", password: "SECRET",
    fileName: "text", productName: "text", status: "text", notes: "text", body: "text", subject: "text", id: "text", customer_id: "text", cc: "text", license: "text", city: "text", tags: "text", created_at: "text",
  };
  for (const [k, v] of Object.entries(want)) assert.equal(type(k), v, k);
  assert.equal(keyRule("ownerName").person, true);
  assert.equal(keyRule("companyName").person, undefined);
});

test("hash mode: the same value gets the same token in every field, record and run; label numbers are per record", () => {
  const o = { mode: "hash", salt: "s1" };
  const a = scrubJson({ ownerName: "KOWALCZYK ZBIGNIEW", ownerPhone: "908 555 0142", note: "call 908 555 0142" }, o), b = scrubJson({ contactName: "KOWALCZYK ZBIGNIEW", phone: "908 555 0142" }, o);
  assert.equal(a.ownerName, b.contactName);
  assert.equal(a.ownerPhone, b.phone);
  assert.equal(a.note, `call ${a.ownerPhone}`);
  assert.notEqual(scrubJson({ ownerName: "KOWALCZYK ZBIGNIEW" }, { mode: "hash", salt: "s2" }).ownerName, a.ownerName);
  assert.equal(scrubJson({ ownerName: "A B" }).ownerName, scrubJson({ ownerName: "C D" }).ownerName, "label mode restarts at 1 in each record");
});

test("a long value in a name field goes to the detectors, numbers in typed fields are replaced, empty values are left", () => {
  const long = "Please call Dana Whitfield about the invoice for the March order, she asked twice already this week. " + "The file is on the shared drive under invoices. ".repeat(3);
  const out = scrubJson({ contactName: long, phone: 9085550142, fax: "", ownerName: null });
  assert.equal(out.contactName, long.replace("Dana Whitfield", "[NAME_1]"), "over 200 characters is not a name");
  assert.deepEqual([out.phone, out.fax, out.ownerName], ["[PHONE_1]", "", null]);
});

test("csv: columns are decided by their header", (t) => {
  const dir = tmp(t);
  write(dir, "owners.csv", "id,OWNER NAME,Property Address,Phone,notes\n1,KOWALCZYK ZBIGNIEW,418 MAPLE ST,908 555 0142-office,Zbigniew called\n2,ADEYEMI THANDIWE,2204-18 HARBOR AVE,(201) 555 - 0146,ok\n");
  assert.equal(run(["scrub", path.join(dir, "owners.csv"), "-o", path.join(dir, "out.csv"), "--quiet"]).status, 0);
  assert.equal(read(dir, "out.csv"), "id,OWNER NAME,Property Address,Phone,notes\n1,[NAME_1],[ADDRESS_1],[PHONE_1],[NAME_1] called\n2,[NAME_1],[ADDRESS_1],[PHONE_1],ok\n");
});

/* ---------------------------------------------------------------- A. plan, policy, audit */

test("plan writes a policy with masked samples; scrub --policy applies it; --strict refuses unknown fields; the report records the policy hash", (t) => {
  const dir = tmp(t), input = write(dir, "props.jsonl", props(500)), policy = path.join(dir, "policy.json");
  const p = run(["plan", input, "-o", policy, "--quiet"]);
  assert.equal(p.status, 0, p.stderr);
  const file = JSON.parse(read(policy)), by = Object.fromEntries(file.fields.map((f) => [f.path, f]));
  assert.equal(file.sampledRecords, 500);
  assert.deepEqual([by.ownerName.action, by.ownerName.type, by["clients[].name"].type, by.notes.action, by.status.action, by.units.action, by._id.action], ["scrub", "NAME", "NAME", "text", "keep", "keep", "keep"]);
  assert.equal(by.ownerName.coverage, 1);
  assert.match(by.ownerName.sample, /^[A ]+$/, "samples show shape only");
  assert.match(by.ownerEmail.sample, /^a+\.a+@a+\.+a+\.a+$/);
  for (let i = 0; i < 500; i += 50) { const k = property(i); assert.ok(!read(policy).includes(k.last) && !read(policy).includes(k.last.toUpperCase())); }

  // Edit the policy: keep company names, hash the id, drop the notes.
  by.companyName.action = "keep"; delete by.companyName.type; by._id.action = "hash"; by.notes.action = "drop";
  fs.writeFileSync(policy, JSON.stringify(file));
  const out = path.join(dir, "clean.jsonl");
  const s = run(["scrub", input, "-o", out, "--policy", policy, "--strict", "--quiet", "--json"]);
  assert.equal(s.status, 0, s.stderr + s.stdout);
  const first = JSON.parse(read(out).split("\n")[0]), src = property(0).record;
  assert.equal(first.companyName, src.companyName);
  assert.match(first._id, /^[0-9a-f]{16}$/);
  assert.ok(!("notes" in first));
  assert.match(first.ownerName, /^\[NAME_1\]$/);
  const report = JSON.parse(s.stdout);
  assert.match(report.options.policy.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.byField.ownerName.NAME, 500);
  assert.equal(report.byField._id.HASH, 500);
  assert.equal(report.audit.ok, true);
  // The same rules give the same hash; changed rules give another.
  by.status.action = "drop"; fs.writeFileSync(policy, JSON.stringify(file));
  const s2 = JSON.parse(run(["scrub", input, "-o", path.join(dir, "c2.jsonl"), "--policy", policy, "--quiet", "--json"]).stdout);
  assert.notEqual(s2.options.policy.sha256, report.options.policy.sha256);
  // A field the policy has never seen.
  const extra = write(dir, "extra.jsonl", '{"_id":"x","surpriseField":"hello"}\n');
  const strict = run(["scrub", extra, "-o", path.join(dir, "e.jsonl"), "--policy", policy, "--strict", "--quiet"]);
  assert.equal(strict.status, 2);
  assert.match(strict.stdout, /--strict: the data has field paths the policy does not list: surpriseField/);
  assert.ok(!fs.existsSync(path.join(dir, "e.jsonl")));
  assert.equal(run(["scrub", extra, "-o", path.join(dir, "e.jsonl"), "--policy", policy, "--quiet"]).status, 0, "without --strict the field name decides");
});

test("audit: scrubbed output passes; raw data and a missed field fail with exit 2 and shape-only samples", (t) => {
  const dir = tmp(t), input = write(dir, "props.jsonl", props(300)), out = path.join(dir, "clean.jsonl");
  const s = run(["scrub", input, "-o", out, "--quiet"]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /Residual check PASS/);
  assert.equal(run(["audit", out, "--quiet"]).status, 0);
  const raw = run(["audit", input, "--quiet", "--json"]);
  assert.equal(raw.status, 2);
  const a = JSON.parse(raw.stdout);
  assert.equal(a.ok, false);
  assert.ok(a.gated.EMAIL >= 300 && a.gated.PHONE >= 300);
  const owner = a.residual.find((r) => r.path === "ownerName" && r.type === "NAME");
  assert.equal(owner.count, 300);
  for (const r of a.residual) for (const sample of r.samples) assert.match(sample, /^[Aa9\W_]*$/, `sample ${sample} shows real characters`);
  // One leaked phone in otherwise clean output: fails at the default limit, passes with --max-residual 1.
  fs.appendFileSync(out, '{"comment":"reach me on 908 555 0142"}\n');
  assert.equal(run(["audit", out, "--quiet"]).status, 2);
  assert.equal(run(["audit", out, "--quiet", "--max-residual", "1"]).status, 0);
  // scrub fails the same way when its own output still holds something, and --no-audit skips the check.
  const kept = write(dir, "keep.json", JSON.stringify({ version: 1, tool: "outrich", fields: [{ path: "ownerPhone", action: "keep" }] }));
  assert.equal(run(["scrub", input, "-o", path.join(dir, "k.jsonl"), "--policy", kept, "--quiet"]).status, 2);
  assert.equal(run(["scrub", input, "-o", path.join(dir, "k2.jsonl"), "--policy", kept, "--no-audit", "--quiet"]).status, 0);
  assert.equal(run(["scrub", input, "-o", path.join(dir, "m.jsonl"), "--mode", "mask", "--quiet"]).status, 0, "mask mode output passes the check");
  assert.equal(run(["scrub", input, "-o", path.join(dir, "h.jsonl"), "--mode", "hash", "--quiet"]).status, 0, "hash mode output passes the check");
});

/* ---------------------------------------------------------------- B. detector fixes */

test("emails with a doubled dot in the domain", () => {
  assert.equal(clean("write to jane.roe@mail..example.com today"), "write to [EMAIL_1] today");
});

test("phones: trailing word, spaced hyphen, trailing letter, trailing bracket, and a ZIP code is not part of the number", () => {
  assert.equal(clean("call 908 555 6000-office after 5"), "call [PHONE_1]-office after 5");
  assert.equal(clean("tel (201) 555 - 0146 thanks"), "tel [PHONE_1] thanks");
  assert.equal(clean("num 973.555.5201E"), "num [PHONE_1]E");
  assert.equal(clean("at 908-555-3484(Mobile)"), "at [PHONE_1](Mobile)");
  assert.equal(clean("ELIZABETH, NJ 07208 908 555 6000-office"), "ELIZABETH, NJ 07208 [PHONE_1]-office");
  assert.equal(clean("order 555-123-4567-8901 shipped"), "order 555-123-4567-8901 shipped", "a longer digit group is still not a phone");
});

test("names: capitals next to a cue, display names, and the address's local part, linked through the record", () => {
  assert.equal(clean("From: ZBIGNIEW KOWALCZYK\nplease advise"), "From: [NAME_1]\nplease advise");
  assert.equal(clean('"Thandiwe Mthembu" <t.mthembu@example.org> wrote: see below. Thandiwe will call. Regards, Mthembu'), '"[NAME_1]" <[EMAIL_1]> wrote: see below. [NAME_1] will call. Regards, [NAME_1]');
  assert.equal(clean("Oluwaseun Adeyemi <office@example.org> said Adeyemi agreed"), "[NAME_1] <[EMAIL_1]> said [NAME_1] agreed");
  assert.equal(clean("mail jane.haugland@example.org. Later Haugland phoned."), "mail [EMAIL_1]. Later [NAME_1] phoned.");
  assert.equal(clean("Accounts Team <billing@example.org> sent it"), "Accounts Team <[EMAIL_1]> sent it", "a role is not a person");
  assert.equal(clean("Thanks,\nRagnhild Haugland"), "Thanks,\n[NAME_1]");
});

test("street addresses in capitals, with no comma or ZIP, and house-number ranges", () => {
  assert.equal(clean("property at 418 MAPLE ST is vacant"), "property at [ADDRESS_1] is vacant");
  assert.equal(clean("lot 2204-18 HARBOR AVE sold"), "lot [ADDRESS_1] sold");
  assert.equal(clean("88 Canal St, Apt 4"), "[ADDRESS_1]");
});

/* ---------------------------------------------------------------- C. mail */

const b64 = (s) => Buffer.from(s).toString("base64");
const MBOX = [
  "From 1234567890@xxx Mon Jan 01 10:00:00 +0000 2024",
  "From: =?UTF-8?B?" + b64("Zoë Haugland") + "?= <zoe.haugland@example.org>",
  'To: "Bartholomew Vanterpool" <b.vanterpool@example.com>, team@example.com',
  "Cc: Anneliese Kim <anneliese@example.net>",
  "Date: Mon, 01 Jan 2024 10:00:00 +0000",
  "Subject: =?iso-8859-1?Q?R=E9sum=E9_for_review?=",
  'Content-Type: multipart/mixed; boundary="XYZ"',
  "",
  "--XYZ",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hi Bartholomew,=20",
  "my number is 908 555 0142-office and the caf=C3=A9 is at 418 MAPLE ST.",
  ">From the desk of Zo=C3=AB",
  "--ALT",
  "Content-Type: text/html",
  "",
  "<p>ignored html</p>",
  "--ALT--",
  "--XYZ",
  'Content-Type: application/pdf; name="resume.pdf"',
  "Content-Disposition: attachment; filename=\"resume.pdf\"",
  "Content-Transfer-Encoding: base64",
  "",
  b64("%PDF-1.4 binary data that must not appear ".repeat(20)),
  "--XYZ--",
  "",
  "From 1234567891@xxx Mon Jan 01 11:00:00 +0000 2024",
  "From: Bartholomew Vanterpool <b.vanterpool@example.com>",
  "To: zoe.haugland@example.org",
  "Date: Mon, 01 Jan 2024 11:00:00 +0000",
  "Subject: Re: review",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64("<html><body><p>Thanks Zo&#235;, call <b>(201) 555 - 0146</b>.</p><script>x()</script></body></html>"),
  "",
].join("\r\n");

test("mbox: messages become JSON records with MIME decoded, then go through the normal scrub", (t) => {
  const dir = tmp(t), src = path.join(dir, "mail");
  write(src, "takeout.mbox", MBOX);
  write(src, "one.eml", MBOX.split(/\r\nFrom 1234567891[^\n]*\n/)[1]);
  // Unscrubbed view first (convert path is not involved; profile reads the records).
  const prof = JSON.parse(run(["profile", src, "--quiet", "--json"]).stdout);
  assert.deepEqual(prof.files.map((f) => [f.path, f.records]), [["one.eml", 1], ["takeout.mbox", 2]]);
  assert.deepEqual(Object.keys(prof.files[1].fields).sort(), ["attachments", "body", "cc", "date", "from", "subject", "to"]);
  const r = run(["scrub", src, "-o", path.join(dir, "out"), "--quiet", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [m1, m2] = read(dir, "out", "takeout.mbox.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(m1.subject, "Résumé for review");
  assert.equal(m1.date, "2024-01-01T10:00:00.000Z");
  assert.deepEqual(m1.attachments, ["resume.pdf"]);
  assert.equal(m1.from, "[NAME_1] <[EMAIL_1]>");
  assert.match(m1.to[0], /^"\[NAME_\d\]" <\[EMAIL_\d\]>$/);
  assert.equal(m1.body, "Hi [NAME_2], \nmy number is [PHONE_1]-office and the café is at [ADDRESS_1]\nFrom the desk of [NAME_1]");
  assert.match(m2.body, /^Thanks \[NAME_\d\], call \[PHONE_1\]\.$/);
  const all = read(dir, "out", "takeout.mbox.jsonl") + read(dir, "out", "one.eml.jsonl");
  for (const leak of ["Haugland", "Vanterpool", "Zoë", "Bartholomew", "Anneliese", "example.org", "PDF-1.4", "ignored html", "x()"]) assert.ok(!all.includes(leak), leak);
  assert.equal(JSON.parse(r.stdout).audit.ok, true);
});

test("mbox: a separator split across read chunks and a gzipped mailbox still give every message", (t) => {
  const dir = tmp(t);
  const many = Array.from({ length: 4000 }, (_, i) => `From ${i}@xxx Mon Jan 01 10:00:00 +0000 2024\r\nFrom: a${i}@example.org\r\nSubject: s${i}\r\n\r\nbody ${i} ${"x".repeat(i % 300)}\r\n`).join("");
  write(dir, "big.mbox.gz", zlib.gzipSync(many));
  const p = JSON.parse(run(["profile", path.join(dir, "big.mbox.gz"), "--quiet", "--json"]).stdout);
  assert.equal(p.totals.records, 4000);
});

/* ---------------------------------------------------------------- D. zip */

function zip(files) { // a minimal writer: deflate, no zip64
  const parts = [], central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const raw = Buffer.from(data), body = zlib.deflateRawSync(raw), n = Buffer.from(name), crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, n, body); central.push(cd, n); offset += 30 + n.length + body.length;
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

test("zip: scrub, profile, plan and manifest read the entries of an archive, a snapshot-style export and a Slack-style export included", async (t) => {
  const dir = tmp(t), a = props(400), day = JSON.stringify([{ user: "U1", text: "ping me at dana.whitfield@example.org", ts: "1.1" }, { user: "U2", text: "ok", ts: "1.2" }]);
  const files = { "inspections/documents.jsonl": a, "_tables/documents.jsonl": '{"name":"inspections","id":1}\n', "general/2024-01-01.json": day, "logo.png": Buffer.from([0x89, 0x50, 0, 0]), "../evil.jsonl": '{"a":1}\n' };
  const archive = write(dir, "snapshot.zip", zip(files));
  const out = path.join(dir, "clean");
  const r = run(["scrub", archive, "-o", out, "--quiet", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.files.map((f) => f.path), ["_tables/documents.jsonl", "general/2024-01-01.json", "inspections/documents.jsonl"]);
  assert.deepEqual(report.skipped.map((s) => s.path).sort(), ["../evil.jsonl", "logo.png"]);
  assert.ok(!fs.existsSync(path.join(dir, "evil.jsonl")));
  assert.equal(read(out, "general", "2024-01-01.json.jsonl"), '{"user":"U1","text":"ping me at [EMAIL_1]","ts":"1.1"}\n{"user":"U2","text":"ok","ts":"1.2"}\n');
  // Same result as scrubbing the unpacked file.
  write(dir, "plain.jsonl", a);
  run(["scrub", path.join(dir, "plain.jsonl"), "-o", path.join(dir, "plain.out.jsonl"), "--quiet"]);
  assert.equal(read(out, "inspections", "documents.jsonl"), read(dir, "plain.out.jsonl"));
  assert.equal(JSON.parse(run(["profile", archive, "--quiet", "--json"]).stdout).totals.records, 400 + 1 + 2);
  assert.equal(run(["plan", archive, "-o", path.join(dir, "policy.json"), "--quiet"]).status, 0);
  assert.ok(JSON.parse(read(dir, "policy.json")).fields.some((f) => f.path === "ownerName" && f.type === "NAME"));
  // The manifest of the archive equals the manifest of the same files unpacked.
  const m1 = JSON.parse(run(["manifest", archive, "-o", path.join(dir, "m1.json"), "--quiet", "--json"]).stdout);
  const un = path.join(dir, "unpacked");
  for (const [name, data] of Object.entries(files)) if (!name.startsWith("..")) write(un, name, data);
  const m2 = JSON.parse(run(["manifest", un, "-o", path.join(dir, "m2.json"), "--quiet", "--json"]).stdout);
  assert.equal(m1.manifestHash, m2.manifestHash);
  assert.equal(run(["verify", archive, path.join(dir, "m2.json"), "--quiet"]).status, 0);
  const notZip = write(dir, "bad.zip", "this is not a zip");
  assert.equal(run(["scrub", notZip, "-o", path.join(dir, "x"), "--quiet"]).status, 2);
});

/* ---------------------------------------------------------------- run */

test("run: one command from raw folder to clean data, policy, residual check, secrets scan, manifest and reports", (t) => {
  const dir = tmp(t), src = path.join(dir, "export");
  write(src, "inspections.jsonl", props(400));
  write(src, "tickets.jsonl", Array.from({ length: 200 }, (_, i) => ticket(i === 17 ? 18 : i).line + "\n").join("")); // ticket 17 carries a planted key; left out here
  const r = run(["run", src, "--quiet"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = src + "-outrich";
  for (const f of ["policy.json", "clean/inspections.jsonl", "clean/tickets.jsonl", "scrub-report.json", "secrets.jsonl", "manifest.json", "outrich-report.json", "REPORT.md"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  const report = JSON.parse(read(out, "outrich-report.json")), md = read(out, "REPORT.md");
  assert.equal(report.status, "complete");
  assert.deepEqual(report.steps.map((s) => s.step), ["plan", "scrub", "secrets", "profile", "manifest"]);
  assert.equal(report.scrub.totals.records, 600);
  assert.equal(report.audit.ok, true);
  assert.equal(report.secrets.findings, 0);
  assert.equal(report.manifest.manifestHash, JSON.parse(read(out, "manifest.json")).manifestHash);
  assert.match(md, /Manifest hash \(SHA-256\): `[0-9a-f]{64}`/);
  assert.match(md, /\| ownerName \| NAME 400 \|/);
  assert.match(md, /Result: PASS/);
  for (let i = 0; i < 400; i += 40) { const k = property(i); for (const v of [k.last, k.last.toUpperCase(), k.email]) assert.ok(!md.includes(v) && !read(out, "outrich-report.json").includes(v), v); }
  assert.equal(run(["verify", path.join(out, "clean"), path.join(out, "manifest.json"), "--quiet"]).status, 0);

  // With a leaked key in the data the run stops before the manifest, unless findings are allowed.
  const src2 = path.join(dir, "export2");
  write(src2, "config.txt", "service settings\n-----BEGIN RSA PRIVATE KEY-----\nabc\n");
  const cfg = write(dir, "run.json", JSON.stringify({ input: "export2", output: "out2" }));
  const stopped = run(["run", cfg, "--quiet"]);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stdout, /Run stopped: the secrets scan found possible credentials/);
  assert.ok(!fs.existsSync(path.join(dir, "out2", "manifest.json")));
  assert.match(read(dir, "out2", "REPORT.md"), /Status: stopped/);
  const allowed = run(["run", cfg, "--quiet", "--allow-findings"]);
  assert.equal(allowed.status, 1);
  assert.ok(fs.existsSync(path.join(dir, "out2", "manifest.json")));
});
