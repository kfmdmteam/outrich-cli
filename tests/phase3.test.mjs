// Regressions from runs on real exports. The data here is synthetic and only imitates the shapes that were missed.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { run, tmp, write, read } from "./helpers.mjs";
import { createWorker, keyRule } from "../dist/outrich.mjs";

const enc = new TextEncoder(), dec = new TextDecoder();
const job = (kind, obj, source = "data.jsonl", options = {}) => createWorker(options)({ kind, fmt: "jsonl", bytes: enc.encode(JSON.stringify(obj) + "\n"), raw: false, endsLine: true, source });
const scrub = (obj, source, options) => JSON.parse(dec.decode(job("scrub", obj, source, options).out));
const residual = (obj, source) => job("audit", obj, source).tally.residual;
const LABEL = /^\[NAME_\d+\]$/;

/* 1. phone keys with a suffix */

test("phone-like keys with digits or other suffixes are phone fields, and bare digits under them are replaced whole", () => {
  for (const k of ["phone10", "phone_e164", "phoneNumber2", "cellPhone", "phones", "mobile2", "tel1", "fax_number", "homePhone", "PHONE_10"]) {
    assert.equal(keyRule(k).type, "PHONE", k);
    for (const v of ["9085550142", 9085550142, "19085550142", "+4420794609580"]) assert.equal(scrub({ [k]: v })[k], "[PHONE_1]", `${k}: ${v}`);
  }
  const out = scrub({ phone: "(908) 555-0142", phone10: "9085550142", note: "ok" });
  assert.deepEqual(out, { phone: "[PHONE_1]", phone10: "[PHONE_1]", note: "ok" }, "the same number in two spellings shares a label");
  assert.equal(keyRule("address2").type, "ADDRESS");
});

test("audit flags digit-only values under phone-like keys", (t) => {
  assert.equal(residual({ phone10: "9085550142" }).phone10.PHONE.n, 1);
  assert.deepEqual(residual({ phone10: "9085550142" }).phone10.PHONE.samples, ["9999999999"]);
  assert.deepEqual(residual({ phone10: "[PHONE_1]", cellPhone: "" }), {});
  const dir = tmp(t), f = write(dir, "leak.jsonl", '{"phone":"[PHONE_1]","phone10":"9085550142"}\n');
  assert.equal(run(["audit", f, "--quiet"]).status, 2);
});

/* 2. owner and name fields are replaced whole */

const OWNERS = [
  "KOWALCZYK ZBIGNIEW", "KOWALCZYK ZBIGNIEW & THANDIWE", "ADEYEMI OLUWASEUN, MTHEMBU THANDIWE", "HAUGLAND RAGNHILD ESTATE OF", "VANTERPOOL BARTHOLOMEW ET AL TRUSTEES OF THE VANTERPOOL FAMILY TRUST",
  "KOWALCZYK ASSOCIATES LLC", "MTHEMBU , LLC", "HAUGLAND REALTY LLC", "418 MAPLE LLC", "123 45TH ST LLC", "2204-18 HARBOR AVE HOLDINGS LLC", "Zbigniew Kowalczyk Jr.", "O'BRIEN-SMITH MARY ANN", "CITY OF LINDEN", "N/A",
];

test("a field whose key says owner or person name is replaced entirely by one label, whatever the value looks like", () => {
  for (const key of ["ownerName", "owner_name", "owner", "contactName", "customerName", "tenantName", "OWNER NAME"]) for (const v of OWNERS) {
    const out = scrub({ [key]: v, units: 3 });
    assert.match(out[key], LABEL, `${key}: ${JSON.stringify(v)} became ${JSON.stringify(out[key])}`);
    assert.deepEqual(residual(out), {}, `${key}: ${v}`);
  }
  // The same value gets the same label within the record; different values get different labels.
  const out = scrub({ ownerName: "418 MAPLE LLC", previousOwner: "418 MAPLE LLC", contactName: "HAUGLAND REALTY LLC" });
  assert.equal(out.ownerName, out.previousOwner);
  assert.notEqual(out.ownerName, out.contactName);
});

test("an entity or address-style owner is replaced but its words are not learned as a person's name; a person's are", () => {
  const entity = scrub({ ownerName: "MAIN STREET HOLDINGS LLC", notes: "The main entrance is on the street side. Holdings paperwork attached." });
  assert.equal(entity.notes, "The main entrance is on the street side. Holdings paperwork attached.");
  const person = scrub({ ownerName: "KOWALCZYK ZBIGNIEW & THANDIWE", notes: "Zbigniew Kowalczyk called; Thandiwe was out. Kowalczyk will call back." });
  assert.match(person.notes, /^\[NAME_\d\] called; \[NAME_\d\] was out\. \[NAME_\d\] will call back\.$/);
});

test("csv: an owner column full of entities and multi-owner values leaves no words behind", (t) => {
  const dir = tmp(t), rows = OWNERS.map((v, i) => `${i},"${v}",${i + 1} units`).join("\n");
  write(dir, "roll.csv", `parcel,OwnerName,desc\n${rows}\n`);
  const r = run(["scrub", path.join(dir, "roll.csv"), "-o", path.join(dir, "out.csv"), "--quiet", "--json"]);
  assert.equal(r.status, 0, r.stdout);
  const lines = read(dir, "out.csv").trim().split("\n").slice(1);
  assert.equal(lines.length, OWNERS.length);
  lines.forEach((l, i) => assert.equal(l, `${i},[NAME_1],${i + 1} units`));
  assert.equal(JSON.parse(r.stdout).byField.OwnerName.NAME, OWNERS.length);
});

/* 3. the bare key "name" */

const ITEM = "Annual Roof Inspection", TEMPLATE = "Welcome Letter", PERSON = "Thandiwe Mthembu";

test("a bare `name` is a thing under item, product, template, table, file or plan paths, or beside price and quantity", () => {
  const order = { id: "o1", lineItems: [{ name: ITEM, price: 250, quantity: 1 }, { name: "Dana Lee Signature Faucet", sku: "F-1" }], template: { name: TEMPLATE }, attachments: [{ name: "Site Photo.jpg", mime: "image/jpeg", size: 1024 }], attachmentName: "Final Report.pdf", productName: "Garden Hose" };
  const out = scrub(order);
  assert.equal(out.lineItems[0].name, ITEM);
  assert.equal(out.lineItems[1].name, "[NAME_1] Signature Faucet", "a dictionary name inside a product name is still caught by the detectors");
  assert.deepEqual([out.template.name, out.attachments[0].name, out.attachmentName, out.productName], [TEMPLATE, "Site Photo.jpg", "Final Report.pdf", "Garden Hose"]);
  assert.deepEqual(scrub({ name: ITEM, price: 9.5, unit: "each" }), { name: ITEM, price: 9.5, unit: "each" }, "beside price and unit");
  // The file a record comes from counts as context: Convex-style table folders.
  for (const source of ["_tables/documents.jsonl", "templates/documents.jsonl", "lineItems/documents.jsonl", "products.jsonl", "export/service_plans.csv"]) assert.equal(scrub({ name: TEMPLATE, id: 1 }, source).name, TEMPLATE, source);
  assert.deepEqual(residual({ lineItems: [{ name: ITEM, price: 1 }] }), {}, "audit does not report a line item name");
});

test("a bare `name` is a person beside email, phone or address, or under client, customer, contact, owner, user, employee, tenant", () => {
  assert.match(scrub({ name: "ADEYEMI HOLDINGS LLC", email: "x@example.org" }).name, LABEL);
  assert.match(scrub({ name: PERSON, phone10: "9085550142" }).name, LABEL);
  assert.match(scrub({ name: PERSON, streetAddress: "418 MAPLE ST" }).name, LABEL);
  for (const parent of ["client", "clients", "customer", "contact", "owner", "user", "person", "employees", "tenant", "primaryContact"]) {
    const v = parent.endsWith("s") ? [{ name: "OLUWASEUN ADEYEMI JR", role: "x" }] : { name: "OLUWASEUN ADEYEMI JR", role: "x" };
    const out = scrub({ [parent]: v });
    assert.match((Array.isArray(out[parent]) ? out[parent][0] : out[parent]).name, LABEL, parent);
  }
  for (const source of ["clients/documents.jsonl", "customers.jsonl", "crm/contacts.csv"]) assert.match(scrub({ name: "OLUWASEUN ADEYEMI JR", id: 1 }, source).name, LABEL, source);
  // The nearest enclosing field wins: a person inside an order, a product inside a customer.
  const mixed = scrub({ order: { customer: { name: PERSON }, items: [{ name: ITEM }] } });
  assert.match(mixed.order.customer.name, LABEL);
  assert.equal(mixed.order.items[0].name, ITEM);
  assert.equal(residual({ customer: { name: PERSON } })["customer.name"].NAME.n, 1, "audit reports a person name left under customer");
});

test("a bare `name` with nothing around it goes to the detectors under its own key", () => {
  assert.equal(scrub({ name: "Dana Whitfield", id: 7 }).name, "[NAME_1]");
  assert.equal(scrub({ name: "inspections", id: 7 }).name, "inspections");
});

test("plan shows the decision and its reason for every field, and a policy made from it scrubs the same way", (t) => {
  const dir = tmp(t), src = path.join(dir, "export");
  const orders = Array.from({ length: 50 }, (_, i) => JSON.stringify({ _id: `o${i}`, customer: { name: PERSON, phone10: "9085550142" }, lineItems: [{ name: ITEM, price: 250 + i, quantity: 1 }], ownerName: OWNERS[i % OWNERS.length], notes: "left a message" }) + "\n").join("");
  write(src, "orders/documents.jsonl", orders);
  write(src, "templates/documents.jsonl", `{"_id":"t1","name":"${TEMPLATE}","body":"Dear customer, welcome."}\n`.repeat(20));
  write(src, "clients/documents.jsonl", `{"_id":"c1","name":"${PERSON}","plan":"pro"}\n`.repeat(20));
  const policy = path.join(dir, "policy.json");
  const p = run(["plan", src, "-o", policy, "--quiet"]);
  assert.equal(p.status, 0, p.stderr);
  const by = Object.fromEntries(JSON.parse(read(policy)).fields.map((f) => [f.path, f]));
  assert.equal(by["lineItems[].name"].action, "text");
  assert.match(by["lineItems[].name"].reason, /name under "lineItems": a thing/);
  assert.deepEqual([by["customer.name"].action, by["customer.name"].type], ["scrub", "NAME"]);
  assert.match(by["customer.name"].reason, /name under "customer": a person/);
  assert.match(by["customer.phone10"].reason, /field name says PHONE/);
  assert.match(by.ownerName.reason, /field name says NAME/);
  assert.match(by.notes.reason, /free text/);
  assert.match(by._id.reason, /nothing detected/);
  // `name` at the top level sits in two kinds of files; plan reports the path once, with the reason seen most often.
  assert.match(by.name.reason, /decided differently across files or records .*a person.*a thing.*Delete this entry/);
  assert.match(p.stdout, /lineItems\[\]\.name\s+text\s+\d+%\s+\S.*name under "lineItems": a thing, read as free text/);
  // Without a policy (or with that entry deleted) each file decides for itself.
  const out = path.join(dir, "clean");
  const s = run(["scrub", src, "-o", out, "--quiet"]);
  assert.equal(s.status, 0, s.stdout);
  assert.equal(JSON.parse(read(out, "templates", "documents.jsonl").split("\n")[0]).name, TEMPLATE);
  assert.match(JSON.parse(read(out, "clients", "documents.jsonl").split("\n")[0]).name, LABEL);
  const first = JSON.parse(read(out, "orders", "documents.jsonl").split("\n")[0]);
  assert.deepEqual([first.lineItems[0].name, first.customer.phone10], [ITEM, "[PHONE_1]"]);
  assert.match(first.ownerName, LABEL);
});
