// Copied from the website repo (tests/pii.test.mjs). Only the two import paths differ: this copy runs the
// website's own test suite against the CLI's tuned copy of the engine (src/lib/pii.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  scrub, createScrubber, scrubTable, analyzeColumns, checkRule, PII_TYPES, approxTokens,
  luhnValid, cardValid, ibanValid, vinValid, abaValid, einValid, ssnValid, itinValid, shannonEntropy, fnv1a64, hashValue,
} from "./.build/cli/pii.mjs";
import { GIVEN, SURNAMES, AMBIGUOUS } from "./.build/cli/pii-names.mjs";

// Secret-shaped fixtures are assembled at runtime so repository secret scanners do not flag this file.
const j = (...p) => p.join("");
const STRIPE = j("sk_", "live_", "9f2c41aa07bb23cd");
const AWS_ID = j("AKIA", "IOSFODNN7EXAMPLE");
const AWS_SECRET = j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY");
const GOOGLE = j("AIza", "SyA1234567890abcdefghijklmnopqrstuv");
const SLACK_HOOK = j("https://hooks.slack.com/", "services/T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX");
const SLACK_TOKEN = j("xox", "b-123456789012-abcdefghijkl");
const GITHUB = j("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789");
const JWT = j("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAKCAQ\n-----END RSA PRIVATE KEY-----";

const ALL = PII_TYPES.map((t) => t.type);
const run = (text, opts = {}) => scrub(text, { types: ALL, ...opts });

test("public API stays backward compatible", () => {
  const r = scrub("a@x.com", { numbered: false });
  assert.equal(r.text, "[EMAIL]");
  assert.deepEqual(r.counts, { EMAIL: 1 });
  assert.equal(r.total, 1);
  assert.equal(approxTokens(400), 100);
  assert.ok(PII_TYPES.every((t) => typeof t.type === "string" && typeof t.label === "string" && typeof t.on === "boolean"));
  assert.equal(PII_TYPES.find((t) => t.type === "URL").on, false);
});

test("validators: Luhn, card, IBAN, VIN, ABA, EIN, SSN, ITIN, entropy", () => {
  assert.ok(luhnValid("4242424242424242") && !luhnValid("4242424242424241"));
  assert.ok(cardValid("4242 4242 4242 4242") && cardValid("378282246310005") && cardValid("5555555555554444"));
  assert.ok(!cardValid("0000 0000 0000 0000") && !cardValid("4242 4242 4242 4241") && !cardValid("1234567812345670"), "Luhn alone is not enough: brand prefix too");
  assert.ok(ibanValid("GB82 WEST 1234 5698 7654 32") && ibanValid("DE89370400440532013000") && ibanValid("NO9386011117947"));
  assert.ok(!ibanValid("GB82 WEST 1234 5698 7654 33") && !ibanValid("XX82 WEST 1234 5698 7654 32") && !ibanValid("GB82 WEST 1234 5698 7654"));
  assert.ok(vinValid("1HGCM82633A004352") && !vinValid("1HGCM82633A004353") && !vinValid("1HGCM82633A00435") && !vinValid("IHGCM82633A004352"));
  assert.ok(abaValid("021000021") && abaValid("011000015") && !abaValid("021000022") && !abaValid("991000028") && !abaValid("02100002"));
  assert.ok(einValid("12-3456789") && !einValid("07-1234567") && !einValid("123456789"));
  assert.ok(ssnValid("123-45-6789") && !ssnValid("000-12-3456") && !ssnValid("666-12-3456") && !ssnValid("912-12-3456") && !ssnValid("123-00-4567") && !ssnValid("123-45-0000"));
  assert.ok(itinValid("912-70-1234") && !itinValid("912-40-1234") && !itinValid("123-70-1234"));
  assert.equal(shannonEntropy("aaaa"), 0);
  assert.ok(shannonEntropy("9f8a7b6c5d4e3f2a") > 3 && shannonEntropy("disabled") < 3);
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
  assert.notEqual(hashValue("x", "s1"), hashValue("x", "s2"));
});

// [name, type, rule, text that must be caught, near-misses that must not be]
const DETECTORS = [
  ["email", "EMAIL", "email", "mail dana@acme.com today", ["price @ 5pm", "a@b", "user@localhost", "@handle and x@.com"]],
  ["phone E.164", "PHONE", "phone-e164", "ring +44 20 7946 0958 please", ["+12 units", "x+1 415 5", "+1 (..) ..-.."]],
  ["phone US", "PHONE", "phone-nanp", "ring 415-555-0142 please", ["123-456-7890", "2026-11-16", "1234 5678 9012", "12-415-555-0142-9"]],
  ["phone national", "PHONE", "phone-national", "ring 020 7946 0958 please", ["01.02.2024 10:30", "046 454 286", "000-12-3456", "0.5 100 200"]],
  ["phone in context", "PHONE", "phone-in-context", "call 4155550142 after lunch", ["invoice 4155550142", "call 2024-01-01", "phones 12345"]],
  ["SSN", "SSN", "ssn", "ssn 123-45-6789 on file", ["000-12-3456", "666-12-3456", "123-45-67890", "1-123-45-6789"]],
  ["SSN in context", "SSN", "ssn-in-context", "SSN 123 45 6789 on file", ["lot 123 45 6789", "SSN 000 45 6789"]],
  ["ITIN", "TAX_ID", "itin", "itin 912-70-1234 on file", ["912-40-1234"]],
  ["EIN", "TAX_ID", "ein", "EIN: 12-3456789 on file", ["EIN 07-1234567", "part 12-3456789", "einstein 12-3456789"]],
  ["UK NI number", "NATIONAL_ID", "uk-nino", "NI number AB 12 34 56 C on file", ["QQ123456C", "GB123456A", "AB123456E"]],
  ["Canadian SIN", "NATIONAL_ID", "ca-sin", "SIN 046 454 286 on file", ["SIN 046 454 287", "since 046 454 286"]],
  ["passport", "PASSPORT", "passport-in-context", "Passport number: 123456789 on file", ["Passport office opens 2024", "tracking 123456789", "passports 123456789"]],
  ["driver's license", "LICENSE", "license-in-context", "Driver's license number D1234567 on file", ["License to kill 2024", "driver's license expired", "licensed 12345678"]],
  ["license number", "LICENSE", "license-in-context", "DL# S123-456-789-012 on file", ["DL team 12345678"]],
  ["date of birth", "DOB", "dob-in-context", "DOB: 03/14/1987 on file", ["Released 03/14/1987", "Date: 2026-11-16", "born in a small town"]],
  ["date of birth in words", "DOB", "dob-in-context", "She was born on March 3, 1987 in Ohio", ["updated on March 3, 1987"]],
  ["card", "CARD", "card-luhn", "card 4242 4242 4242 4242 on file", ["4242 4242 4242 4241", "0000 0000 0000 0000", "1234 5678 9012 3456"]],
  ["IBAN", "IBAN", "iban-mod97", "IBAN GB82 WEST 1234 5698 7654 32 on file", ["GB82 WEST 1234 5698 7654 33", "XX82 WEST 1234 5698 7654 32"]],
  ["routing number", "BANK", "aba-routing", "Routing number 021000021 on file", ["routing 021000022", "number 021000021"]],
  ["bank account", "BANK", "bank-account-in-context", "account number 123456789012 on file", ["account number pending", "total 123456789012", "account number 12"]],
  ["Ethereum address", "CRYPTO", "eth-address", "send to 0x52908400098527886E0F7030069857D2E4169EE7 now", ["0x52908400098527886E0F7030069857D2E4169EE", "0xZZ908400098527886E0F7030069857D2E4169EE7"]],
  ["Bitcoin address", "CRYPTO", "btc-base58", "send to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa now", ["1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf0O"]],
  ["Bitcoin bech32", "CRYPTO", "btc-bech32", "send to bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 now", ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"]],
  ["IPv4", "IP", "ipv4", "from 203.0.113.7 today", ["999.1.1.1", "version 1.2.3.4", "1.2.3.4.5", "4.2.1"]],
  ["IPv6", "IP", "ipv6", "from 2001:0db8:85a3:0000:0000:8a2e:0370:7334 today", ["at 12:30:45", "std::string a::b", "1:2:3"]],
  ["IPv6 short form", "IP", "ipv6", "from fe80::1ff:fe23:4567:890a today", ["dead::beef"]],
  ["MAC", "MAC", "mac", "nic 00:1B:44:11:3A:B7 up", ["00:1B:44:11:3A", "00:00:00:00:00:00", "00:1B-44:11-3A:B7"]],
  ["VIN", "VIN", "vin-check-digit", "car 1HGCM82633A004352 sold", ["1HGCM82633A004353", "12345678901234567", "ABCDEFGHJKLMNPRST"]],
  ["VIN in context", "VIN", "vin-in-context", "VIN: WVWZZZ1JZXW000001 sold", ["vinyl WVWZZZ1JZXW000001"]],
  ["street address", "ADDRESS", "street-address", "Ship to 88 Canal St today", ["5 Things I like", "88 percent of users"]],
  ["PO box", "ADDRESS", "po-box", "Mail to PO Box 1234 today", ["PO Box tbd"]],
  ["ID with a cue word", "ID", "id-in-context", "customer ID C-10293 closed", ["Order 1234567 shipped", "member since 2019", "user-agent Mozilla", "case-sensitive match", "order 10kg flour"]],
  ["ID with a number sign", "ID", "id-in-context", "order #12345 closed", ["ticket 48213 closed"]],
  ["URL", "URL", "url", "see https://example.com/u/42?x=1 now", ["http:/broken.example", "example.com/u/42"]],
  ["private key block", "SECRET", "private-key", PEM, ["-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----"]],
  ["Stripe key", "SECRET", "stripe-key", `key ${STRIPE} here`, [j("sk_", "live_", "abc"), "sk_alive_1234567890abcdef"]],
  ["AWS access key id", "SECRET", "aws-access-key", `id ${AWS_ID} here`, [j("AKIA", "IOSFODNN7EXAMPL"), j("AKIA", "IOSFODNN7EXAMPLEXX")]],
  ["AWS secret key", "SECRET", "aws-secret-key", `aws_secret_access_key = ${AWS_SECRET}`, ["aws_secret_access_key = <your key here>", "aws_secret_access_key = null"]],
  ["Google API key", "SECRET", "google-api-key", `key ${GOOGLE} here`, [j("AIza", "123"), GOOGLE + "x"]],
  ["Slack webhook", "SECRET", "slack-webhook", `post to ${SLACK_HOOK} now`, ["https://hooks.slack.com/docs"]],
  ["Slack token", "SECRET", "slack-token", `token ${SLACK_TOKEN} here`, [j("xox", "b-12")]],
  ["GitHub token", "SECRET", "github-token", `use ${GITHUB} here`, [j("gh", "p_", "short")]],
  ["JWT", "SECRET", "jwt", `jwt ${JWT} here`, ["eyJhbGciOiJIUzI1NiJ9 only a header"]],
  ["bearer token", "SECRET", "bearer-token", "Authorization: Bearer abc123DEF456ghi789", ["the bearer of bad news arrived", "bearer authentication is used"]],
  ["secret assignment", "SECRET", "secret-assignment", "api_key: 9f8a7b6c5d4e3f2a", ["token: disabled", "secret: my-secret-value", "token_ttl = 3600"]],
  ["high-entropy string", "SECRET", "high-entropy-string", "session token Zx9Kq2Lm8Pw4Rt6Yv1Bn3Cd5 was issued", ["token disabledbydefaultsetting", "token expires tomorrow"]],
  ["password", "SECRET", "password-assignment", "password = hunter2secret", ["password is required", "password: <your password>", "password = request.form['p']", "passwords are hashed"]],
  ["connection string", "SECRET", "connection-string", "postgres://app:s3cr3tPass@db.internal:5432/prod", ["postgres://db.internal:5432/prod", "mailto:app@db.internal"]],
  ["basic auth in a URL", "SECRET", "basic-auth-url", "curl https://user:hunter2@example.com/x", ["https://example.com/a:b", "https://example.com:8443/x@y"]],
  ["token in a query string", "SECRET", "url-token", "https://api.example.com/v1?access_token=abcdef1234567890&x=1", ["https://example.com/?page=12345678&sort=asc", "https://example.com/?token=short"]],
];

for (const [name, type, rule, hit, misses] of DETECTORS) {
  test(`detector: ${name}`, () => {
    // The whole-URL rule would swallow secrets inside URLs, so it is only on for its own test.
    const opts = type === "URL" ? {} : { types: ALL.filter((t) => t !== "URL") };
    const r = run(hit, opts);
    assert.ok(r.counts[type] >= 1, `expected ${type} in: ${hit}\n${r.text}`);
    assert.ok(r.rules[rule] >= 1, `expected rule ${rule}, got ${JSON.stringify(r.rules)}`);
    for (const miss of misses) {
      const m = run(miss, opts);
      assert.equal(m.rules[rule], undefined, `false positive (${rule}) in: ${miss}\n${m.text}`);
      assert.equal(m.counts[type], undefined, `false positive (${type}) in: ${miss}\n${m.text}`);
    }
  });
}

test("secrets inside URLs: only the secret goes, and a whole-URL rule takes over when URLs are on", () => {
  assert.equal(scrub("postgres://app:s3cr3tPass@db.internal:5432/prod").text, "postgres://app:[SECRET_1]@db.internal:5432/prod");
  assert.equal(scrub("https://x.io/a?access_token=abcdef1234567890&page=2").text, "https://x.io/a?access_token=[SECRET_1]&page=2");
  assert.equal(run("see https://user:hunter2@example.com/x.").text, "see [URL_1].");
  assert.equal(scrub('{"password": "correct horse, battery"}').text, '{"password": "[SECRET_1]"}');
  assert.equal(scrub("the password is Tr0ub4dor&3 ok").text, "the password is [SECRET_1] ok");
});

test("mode: label, with and without numbering", () => {
  assert.equal(scrub("a@x.com b@x.com a@x.com").text, "[EMAIL_1] [EMAIL_2] [EMAIL_1]");
  assert.equal(scrub("a@x.com b@x.com", { mode: "label", numbered: false }).text, "[EMAIL] [EMAIL]");
  assert.equal(scrub("(415) 555-0142 or 415-555-0142").text, "[PHONE_1] or [PHONE_1]", "same number, different formatting, one label");
});

test("mode: mask keeps the shape", () => {
  const m = (t) => scrub(t, { mode: "mask" }).text;
  assert.equal(m("dana.w@northlake.io"), "d*****@n********.io");
  assert.equal(m("(415) 555-0142"), "(***) ***-0142");
  assert.equal(m("4242 4242 4242 4242"), "**** **** **** 4242");
  assert.equal(m("ssn 123-45-6789"), "ssn ***-**-6789");
  assert.equal(m("From: Dana Whitfield"), "From: D*** W********");
  assert.equal(m("host 203.0.113.7"), "host ***.*.***.*");
});

test("mode: hash is stable, salted and never contains the value", () => {
  const a = scrub("a@x.com then a@x.com and b@x.com", { mode: "hash", salt: "s1" }).text;
  const [h1, h2, h3] = a.match(/\[EMAIL_[0-9a-f]{10}\]/g);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(scrub("again a@x.com", { mode: "hash", salt: "s1" }).text, `again ${h1}`, "stable across runs");
  assert.notEqual(scrub("a@x.com", { mode: "hash", salt: "s2" }).text, h1, "salt changes the token");
  assert.ok(!a.includes("x.com"));
});

test("mode: synthetic is fake, consistent and format-preserving", () => {
  const input = "From: Dana Whitfield <dana.w@northlake.io>\nCall (415) 555-0142 or (415) 555-0142. Card 4242 4242 4242 4242. Host 203.0.113.7 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334. SSN 123-45-6789.\nDana Whitfield agreed. Dana too. Other: marcus@acme.io, +44 20 7946 0958. DOB: 03/14/1987";
  const { text } = scrub(input, { mode: "synthetic" });
  for (const leak of ["Dana", "Whitfield", "northlake", "0142", "4242", "203.0.113", "8a2e", "6789", "marcus", "7946", "1987"]) assert.ok(!text.includes(leak), `leaked ${leak}\n${text}`);
  const emails = text.match(/[\w.]+@example\.com/g);
  assert.equal(emails.length, 2);
  assert.notEqual(emails[0], emails[1]);
  const phones = text.match(/\(\d{3}\) \d{3}-\d{4}/g);
  assert.equal(phones.length, 2);
  assert.equal(phones[0], phones[1], "same value, same fake");
  assert.match(phones[0], /555-01\d\d$/);
  const card = text.match(/\d{4} \d{4} \d{4} \d{4}/)[0];
  assert.ok(luhnValid(card) && card.startsWith("4000"), `fake card must pass Luhn: ${card}`);
  assert.match(text, /Host 192\.0\.2\.\d+ and 2001:db8::/);
  assert.match(text, /SSN 000-00-\d{4}/);
  assert.match(text, /DOB: 01\/01\/1970/);
  const [full] = text.match(/^From: (\S+ \S+)/m).slice(1);
  assert.ok(text.includes(`${full} agreed. ${full.split(" ")[0]} too.`), `first name alone maps to the same fake first name\n${text}`);
  assert.equal(scrub(input, { mode: "synthetic" }).text, text, "deterministic");
});

test("mode: remove deletes the values", () => {
  assert.equal(scrub("mail a@x.com now", { mode: "remove" }).text, "mail  now");
});

test("labels and synthetic values stay consistent across chunks, and offsets continue", () => {
  const s = createScrubber();
  assert.equal(s.scrub("one a@x.com\n").text, "one [EMAIL_1]\n");
  const second = s.scrub("two b@x.com a@x.com\n");
  assert.equal(second.text, "two [EMAIL_2] [EMAIL_1]\n");
  assert.equal(second.findings[0].start, 12 + 4);
  assert.equal(second.findings[0].outStart, "one [EMAIL_1]\n".length + 4);
  const n = createScrubber();
  n.scrub("From: Dana Whitfield\n");
  assert.equal(n.scrub("Later Dana Whitfield and Dana replied.\n").text, "Later [NAME_1] and [NAME_1] replied.\n", "names learned in one chunk apply to the next");
  const f = createScrubber({ mode: "synthetic" });
  assert.equal(f.scrub("a@x.com").text, f.scrub("a@x.com").text);
});

test("findings: positions, values, rules and the cap", () => {
  const input = "mail a@x.com now";
  const r = scrub(input);
  assert.deepEqual(r.findings, [{ type: "EMAIL", start: 5, end: 12, value: "a@x.com", replacement: "[EMAIL_1]", rule: "email", outStart: 5 }]);
  assert.equal(input.slice(r.findings[0].start, r.findings[0].end), "a@x.com");
  assert.equal(r.text.slice(5, 5 + "[EMAIL_1]".length), "[EMAIL_1]");
  assert.ok(r.ms >= 0 && r.truncated === false);
  const capped = scrub("a@x.com b@x.com c@x.com", { maxFindings: 2 });
  assert.equal(capped.findings.length, 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.total, 3, "counts are never truncated");
  assert.equal(scrub("a@x.com", { findings: false }).findings.length, 0);
});

test("allowlist keeps a value and everything inside it", () => {
  assert.equal(scrub("support@acme.com and dana@acme.com", { allow: ["Support@acme.com"] }).text, "support@acme.com and [EMAIL_1]");
  assert.equal(scrub("From: Dana Whitfield", { allow: ["dana whitfield"] }).text, "From: Dana Whitfield");
  assert.equal(scrub("Host 203.0.113.7 and 203.0.113.8", { allow: ["203.0.113.7"] }).text, "Host 203.0.113.7 and [IP_1]");
});

test("custom terms", () => {
  assert.equal(scrub("Acme Corp called. acme corp again. Acme Corporation did not.", { custom: ["Acme Corp"] }).text, "[CUSTOM_1] called. [CUSTOM_1] again. Acme Corporation did not.");
  assert.equal(scrub("Project Falcon and Falcon", { custom: ["Falcon", "Project Falcon"] }).text, "[CUSTOM_1] and [CUSTOM_2]", "longest term wins");
});

test("custom regex rules: applied, labelled, and bad ones reported instead of thrown", () => {
  const r = scrub("TCK-1234 then TCK-9999 then TCK-1234", { rules: [{ label: "Ticket", pattern: "TCK-\\d{4}" }] });
  assert.equal(r.text, "[TICKET_1] then [TICKET_2] then [TICKET_1]");
  assert.equal(r.counts.CUSTOM, 3);
  assert.equal(r.rules["custom-regex:TICKET"], 3);
  assert.equal(scrub("Tck-1234", { rules: [{ label: "t", pattern: "tck-\\d+", flags: "i" }] }).text, "[T_1]");

  const bad = scrub("x 555 y a@x.com", { rules: [{ label: "bad", pattern: "(" }, { label: "evil", pattern: "(a+)+$" }, { label: "empty", pattern: "\\d*" }, { label: "num", pattern: "\\d+" }] });
  assert.equal(bad.text, "x [NUM_1] y [EMAIL_1]", "valid rules and built-in detectors still run");
  assert.deepEqual(bad.ruleErrors.map((e) => e.label), ["bad", "evil", "empty"]);
  assert.ok(bad.ruleErrors.every((e) => e.error.length > 5));
  assert.equal(checkRule({ label: "ok", pattern: "[A-Z]{3}-\\d+" }), null);
  assert.match(checkRule({ label: "x", pattern: "a", flags: "g" }), /flags/);
  assert.match(checkRule({ label: "x", pattern: " " }), /Enter/);
});

test("name dictionary is real", () => {
  assert.ok(GIVEN.size >= 1500, `given names: ${GIVEN.size}`);
  assert.ok(SURNAMES.size >= 1000, `surnames: ${SURNAMES.size}`);
  for (const n of ["dana", "maria", "priya", "wei", "mohammed", "kwame", "giovanni", "hiroshi"]) assert.ok(GIVEN.has(n), n);
  for (const n of ["whitfield", "garcia", "patel", "nguyen", "haddad", "okafor", "kowalski", "tanaka"]) assert.ok(SURNAMES.has(n), n);
  for (const n of ["will", "mark", "rose", "grace", "may", "hope", "bill", "jack", "art", "rich", "joy", "faith", "summer", "chase", "hunter", "mason"]) assert.ok(AMBIGUOUS.has(n), n);
  for (const n of ["turner", "smith", "dana", "paul"]) assert.ok(!AMBIGUOUS.has(n), n);
});

test("names: stoplist words are only names inside a two-word name", () => {
  for (const safe of ["Will you mark the date", "Will you mark the date for May? Grace and hope matter. Chase the bill, Jack.", "Rose Garden opens in Summer. Chase Bank and Art House.", "Mark Price As Final"]) {
    assert.equal(scrub(safe).text, safe);
  }
  assert.equal(scrub("Will Turner will attend.").text, "[NAME_1] will attend.");
  assert.equal(scrub("Ask Grace Sullivan or Mark Davis.").text, "Ask [NAME_1] or [NAME_2].");
});

test("names: dictionary, title and cue rules", () => {
  assert.equal(scrub("Yesterday Emma Watson joined.").text, "Yesterday [NAME_1] joined.", "given name + capitalized word");
  assert.equal(scrub("We met Priya Raman and Dr. Okafor.").text, "We met [NAME_1] and Dr. [NAME_2].");
  assert.equal(scrub("Signed by Maria Garcia Lopez today").text, "Signed by [NAME_1] today", "second surname is included");
  assert.equal(scrub("Signed by Dana J. Whitfield today").text, "Signed by [NAME_1] today", "middle initial");
  assert.equal(scrub("STATEMENT FOR DANA WHITFIELD").text, "STATEMENT FOR [NAME_1]");
  assert.equal(scrub("Best regards,\nMarcus Aurelius").text, "Best regards,\n[NAME_1]");
  assert.equal(scrub('{"name": "Zbigniew Okonjo", "note": "Zbigniew Okonjo called"}').text, '{"name": "[NAME_1]", "note": "[NAME_1] called"}');
  for (const safe of ["Hi Team,", "Dear Customer Support", "Dana Street is closed", "Regards,\nThe Billing Team", "Thanks for the update", "Emma said hello on Monday"]) {
    assert.equal(scrub(safe).counts.NAME, undefined, safe);
  }
});

test("names: email linking and propagation of full names and parts", () => {
  const { text } = scrub("Contact dana.whitfield@northlake.io. Later Dana Whitfield called; Dana agreed. Whitfield too.");
  assert.equal(text, "Contact [EMAIL_1]. Later [NAME_1] called; [NAME_1] agreed. [NAME_1] too.");
  assert.equal(scrub("Mail customer.support@acme.io. Customer Support replied.").counts.NAME, undefined, "role mailboxes are not names");
  assert.equal(scrub("Dear Rose Whitfield,\nRose petals fell. Whitfield agreed.").text, "Dear [NAME_1],\nRose petals fell. [NAME_1] agreed.", "an ambiguous part never propagates alone");
  assert.equal(scrub("Emma left early.\nFrom: Emma Watson").text, "[NAME_1] left early.\nFrom: [NAME_1]", "a name learned later applies to earlier mentions");
  assert.equal(scrub("Dana's laptop. From: Dana Whitfield").text, "[NAME_1]'s laptop. From: [NAME_1]");
});

test("names: sensitivity levels", () => {
  assert.equal(scrub("Yesterday Emma Watson joined.", { nameSensitivity: "context" }).text, "Yesterday Emma Watson joined.");
  assert.equal(scrub("From: Emma Watson\nYesterday Emma Watson joined. Emma left.", { nameSensitivity: "context" }).text, "From: [NAME_1]\nYesterday [NAME_1] joined. Emma left.");
  assert.equal(scrub("Then Marcus agreed.").text, "Then Marcus agreed.", "balanced leaves a lone first name without context");
  assert.equal(scrub("Then Marcus agreed.", { nameSensitivity: "aggressive" }).text, "Then [NAME_1] agreed.");
  assert.equal(scrub("Then Will agreed in May.", { nameSensitivity: "aggressive" }).text, "Then Will agreed in May.", "stoplist still applies");
});

test("scrubTable applies a policy per column and keeps labels consistent", () => {
  const rows = [
    { id: 1, email: "a@x.com", first_name: "Dana", note: "call (415) 555-0142\nor a@x.com", junk: "x", meta: { contact: "b@x.com", n: 5 } },
    { id: 2, email: "b@x.com", first_name: "Dana", note: "all good", junk: "y", meta: { contact: "a@x.com", n: 7 } },
  ];
  const r = scrubTable(rows, { id: "keep", first_name: "hash", junk: "drop" }, { salt: "pepper" });
  assert.deepEqual(Object.keys(r.rows[0]), ["id", "email", "first_name", "note", "meta"]);
  assert.equal(r.rows[0].id, 1, "kept columns keep their type");
  assert.equal(r.rows[0].email, "[EMAIL_1]");
  assert.equal(r.rows[1].email, "[EMAIL_2]");
  assert.equal(r.rows[0].note, "call [PHONE_1]\nor [EMAIL_1]", "same value, same label, in any column");
  assert.deepEqual(r.rows[0].meta, { contact: "[EMAIL_2]", n: 5 }, "nested values are cleaned; numbers stay numbers");
  assert.match(r.rows[0].first_name, /^[0-9a-f]{16}$/);
  assert.equal(r.rows[0].first_name, r.rows[1].first_name);
  assert.equal(r.rows[0].first_name, hashValue("Dana", "pepper"));
  assert.equal(r.columns.email.counts.EMAIL, 2);
  assert.equal(r.columns.note.counts.PHONE, 1);
  assert.equal(r.columns.junk.policy, "drop");
  assert.equal(r.total, 6);
  assert.equal(rows[0].email, "a@x.com", "input rows are not modified");
  assert.deepEqual(scrubTable([{ a: "a@x.com" }], {}, { defaultPolicy: "keep" }).rows, [{ a: "a@x.com" }]);
  assert.deepEqual(scrubTable([{ a: "a@x.com", n: 4155550142 }], { n: "scrub" }, { mode: "remove" }).rows, [{ a: "", n: 4155550142 }]);
});

test("analyzeColumns suggests a policy per column", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), email: `u${i}@x.com`, first_name: ["Dana", "Marcus"][i % 2], note: "customer asked for a refund", product_name: "Widget", status: "open" }));
  const cols = Object.fromEntries(analyzeColumns(rows).map((c) => [c.name, c]));
  assert.deepEqual(cols.email.types, ["EMAIL"]);
  assert.equal(cols.email.suggested, "scrub");
  assert.equal(cols.first_name.suggested, "hash", "a column of bare first names needs hashing, patterns cannot see it");
  assert.equal(cols.note.suggested, "scrub");
  assert.equal(cols.id.suggested, "keep");
  assert.equal(cols.product_name.suggested, "keep");
  assert.equal(cols.status.suggested, "keep");
});

test("performance: 5 MB of mixed text in under 5 seconds", () => {
  const line = "2026-03-14 12:01:22 INFO ticket 48213 from Dana Whitfield <dana.whitfield@northlake.io> phone (415) 555-0142: sync failed, order number 778812, server 203.0.113.7. Thanks, Marcus\n";
  const filler = "The quick brown fox jumps over the lazy dog while the Engineering Team reviews quarterly Reports for version 4.2.1 of the product, costing 1,234.56 dollars.\n";
  let text = "";
  for (let i = 0; text.length < 5 * 1024 * 1024; i++) text += i % 4 ? filler : line.replace("48213", String(40000 + i)).replace("dana.whitfield", `user${i}`);
  const t0 = performance.now();
  const r = scrub(text, { maxFindings: 10000 });
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
  assert.ok(r.total > 30000 && r.counts.EMAIL > 6000 && r.counts.PHONE > 6000);
  assert.ok(!r.text.includes("@northlake.io") && !r.text.includes("555-0142"));
  assert.ok(r.truncated && r.findings.length === 10000, "findings are capped, counts are not");
});

test("adversarial input does not trigger catastrophic backtracking", () => {
  const cases = {
    "50,000 a": "a".repeat(50000), "50,000 digits": "1".repeat(50000), "50,000 capitals": "A".repeat(50000), "at signs": "@".repeat(50000),
    "a@ pairs": "a@".repeat(25000), "jwt prefixes": "eyJ".repeat(20000), "spaced digits": "1 ".repeat(25000), "colons": "a:".repeat(25000),
    "plus signs": "+1 ".repeat(20000), "open key blocks": "-----BEGIN PRIVATE KEY-----\n".repeat(2000), "zero groups": "01 ".repeat(20000),
    "url schemes": "://a:".repeat(10000), "names": "Dana ".repeat(10000), "hex pairs": "ab:".repeat(20000), "cue words": "password".repeat(6000),
    "parens": "(".repeat(50000), "dotted digits": "1.".repeat(25000), "dashes": "1-".repeat(25000), "long token cue": `token ${"aB3".repeat(20000)}`,
    "iban-ish": "GB82 ".repeat(10000), "quotes": '"name": "'.repeat(5000), "titles": "Dr. ".repeat(12000), "street": "1 A ".repeat(12000),
  };
  for (const [name, input] of Object.entries(cases)) {
    const t0 = performance.now();
    scrub(input, { types: ALL });
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${name} took ${Math.round(ms)} ms`);
  }
});
