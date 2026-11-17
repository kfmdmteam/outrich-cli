// Connectors against a local mock server that replays the vendors' documented response shapes:
// pagination, a 429 with Retry-After, an error. Nothing here contacts a real service.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { BIN, tmp, read } from "./helpers.mjs";

const TOKEN = "tok_" + "s3cr3t-value-that-must-never-appear";

/** Starts a server. `routes` maps "METHOD /path" prefixes to handlers returning [status, body, headers?]. Every request is recorded. */
async function mock(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, headers: req.headers });
    const [status, body, headers = {}] = handler(url, seen.length, req) ?? [404, { error: "no route" }];
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((ok) => server.close(ok)) };
}

function cli(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, OUTRICH_MAX_WAIT_MS: "20", ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (status) => ok({ status, stdout, stderr }));
  });
}
const lines = (...p) => read(...p).trim().split("\n").map((l) => JSON.parse(l));
const noToken = (t, dir, r) => {
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), "token printed");
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes(TOKEN), `token written to ${f}`); }
};

test("zendesk: cursor export with comments, a 429 that is retried, and resume after a failure without duplicates", async (t) => {
  const dir = tmp(t), out = path.join(dir, "zd");
  let limited = false, broken = true;
  const m = await mock((url) => {
    if (url.pathname === "/api/v2/incremental/tickets/cursor.json") {
      const cursor = url.searchParams.get("cursor");
      if (!cursor) { if (!limited) { limited = true; return [429, { error: "rate" }, { "retry-after": "0" }]; } return [200, { tickets: [{ id: 1, subject: "a" }, { id: 2, subject: "b" }], after_cursor: "c2", end_of_stream: false }]; }
      if (cursor === "c2") { if (broken) return [500, { error: "boom" }]; return [200, { tickets: [{ id: 3, subject: "c" }], after_cursor: "c3", end_of_stream: true }]; }
    }
    const tm = /^\/api\/v2\/tickets\/(\d+)\/comments\.json$/.exec(url.pathname);
    if (tm) return url.searchParams.get("page[after]") ? [200, { comments: [{ id: +tm[1] * 10 + 2, body: "second" }], meta: { has_more: false } }]
      : [200, { comments: [{ id: +tm[1] * 10 + 1, body: "first" }], meta: { has_more: true, after_cursor: "p2" } }];
  });
  t.after(m.close);
  const env = { OUTRICH_ZENDESK_TOKEN: TOKEN, OUTRICH_ZENDESK_EMAIL: "admin@example.com" };
  const args = ["pull", "zendesk", "--base-url", m.base, "--since", "2024-01-01", "-o", out, "--quiet"];
  const first = await cli(args, env);
  assert.equal(first.status, 2);
  assert.match(first.stderr, /zendesk: the API answered 500/);
  assert.ok(fs.existsSync(path.join(out, ".outrich-pull.json")), "a checkpoint is kept");
  noToken(t, out, first);
  broken = false;
  const second = await cli([...args, "--resume", "--json"], env);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(lines(out, "tickets.jsonl").map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(lines(out, "ticket_comments.jsonl").map((x) => [x.ticket_id, x.id]), [[1, 11], [1, 12], [2, 21], [2, 22], [3, 31], [3, 32]]);
  assert.equal(JSON.parse(second.stdout).records, 9);
  assert.ok(!fs.existsSync(path.join(out, ".outrich-pull.json")));
  assert.equal(m.seen[0].query.start_time, String(Date.UTC(2024, 0, 1) / 1000));
  assert.equal(m.seen[0].auth, "Basic " + Buffer.from(`admin@example.com/token:${TOKEN}`).toString("base64"));
  assert.ok(m.seen.every((s) => !JSON.stringify(s.query).includes(TOKEN) && !s.path.includes(TOKEN)), "the token travels in a header only");
  noToken(t, out, second);
  // A finished export is not appended to by accident.
  const again = await cli(args, env);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already holds \.jsonl files/);
});

test("github: Link-header pagination for issues, pulls and comments; a link to another host is refused; rate limit by reset header", async (t) => {
  const dir = tmp(t);
  let waited = false;
  const m = await mock((url, n) => {
    const page = Number(url.searchParams.get("page") ?? 1), kind = url.pathname.replace("/repos/acme/app/", "");
    if (kind === "issues" && page === 1 && !waited) { waited = true; return [403, { message: "rate limit" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000)) }]; }
    if (["issues", "pulls", "issues/comments", "pulls/comments"].includes(kind))
      return page === 1 ? [200, [{ id: 1, kind }, { id: 2, kind }], { link: `<${m.base}${url.pathname}?per_page=100&page=2>; rel="next", <${m.base}${url.pathname}?page=2>; rel="last"` }] : [200, [{ id: 3, kind }]];
    if (url.pathname === "/orgs/evil/repos") return [200, [{ full_name: "evil/x" }], { link: `<https://attacker.example.net/orgs/evil/repos?page=2>; rel="next"` }];
  });
  t.after(m.close);
  const env = { OUTRICH_GITHUB_TOKEN: TOKEN }, out = path.join(dir, "gh");
  const r = await cli(["pull", "github", "--target", "acme/app", "--base-url", m.base, "-o", out, "--quiet"], env);
  assert.equal(r.status, 0, r.stderr);
  for (const k of ["issues", "pulls", "issue_comments", "review_comments"]) assert.deepEqual(lines(out, `acme__app.${k}.jsonl`).map((x) => x.id), [1, 2, 3], k);
  assert.equal(m.seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(m.seen[0].headers["x-github-api-version"], "2022-11-28");
  noToken(t, out, r);
  const bad = await cli(["pull", "github", "--target", "evil", "--base-url", m.base, "-o", path.join(dir, "gh2"), "--quiet"], env);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /refused to contact https:\/\/attacker\.example\.net/);
  const plain = await cli(["pull", "github", "--target", "a/b", "--base-url", "http://example.com", "-o", path.join(dir, "gh3"), "--quiet"], env);
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /only https is allowed/);
});

test("jira: nextPageToken search and per-issue comments with startAt paging; a 401 is reported without the token", async (t) => {
  const dir = tmp(t);
  const m = await mock((url, n, req) => {
    if (!req.headers.authorization?.startsWith("Basic ")) return [401, { errorMessages: ["bad credentials"] }];
    if (url.pathname === "/rest/api/3/search/jql") return url.searchParams.get("nextPageToken") ? [200, { issues: [{ key: "OPS-3" }], isLast: true }] : [200, { issues: [{ key: "OPS-1" }, { key: "OPS-2" }], nextPageToken: "t2", isLast: false }];
    const im = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(url.pathname);
    if (im) { const at = Number(url.searchParams.get("startAt")); return [200, { startAt: at, maxResults: 100, total: 2, comments: [{ id: `${im[1]}-c${at}` }] }]; }
  });
  t.after(m.close);
  const out = path.join(dir, "jira");
  const r = await cli(["pull", "jira", "--base-url", m.base, "-o", out, "--quiet"], { OUTRICH_JIRA_TOKEN: TOKEN, OUTRICH_JIRA_EMAIL: "me@example.com" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(out, "issues.jsonl").map((x) => x.key), ["OPS-1", "OPS-2", "OPS-3"]);
  assert.deepEqual(lines(out, "issue_comments.jsonl").map((x) => x.id), ["OPS-1-c0", "OPS-1-c1", "OPS-2-c0", "OPS-2-c1", "OPS-3-c0", "OPS-3-c1"]);
  assert.match(m.seen[0].query.jql, /created >= "1970-01-01"/);
  assert.equal(m.seen[0].auth, "Basic " + Buffer.from(`me@example.com:${TOKEN}`).toString("base64"));
  const missing = await cli(["pull", "jira", "--base-url", m.base, "-o", path.join(dir, "j2"), "--quiet"], { OUTRICH_JIRA_TOKEN: "", OUTRICH_JIRA_EMAIL: "" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Set OUTRICH_JIRA_EMAIL in the environment/);
});

test("intercom: cursor list, each conversation fetched in full", async (t) => {
  const dir = tmp(t);
  const m = await mock((url) => {
    if (url.pathname === "/conversations") return url.searchParams.get("starting_after") ? [200, { type: "conversation.list", conversations: [{ id: "3" }], pages: {} }] : [200, { conversations: [{ id: "1" }, { id: "2" }], pages: { next: { page: 2, starting_after: "abc" } } }];
    const c = /^\/conversations\/(\d+)$/.exec(url.pathname);
    if (c) return [200, { id: c[1], conversation_parts: { conversation_parts: [{ body: `<p>part of ${c[1]}</p>` }] } }];
  });
  t.after(m.close);
  const out = path.join(dir, "ic");
  const r = await cli(["pull", "intercom", "--base-url", m.base, "-o", out, "--quiet"], { OUTRICH_INTERCOM_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(out, "conversations.jsonl").map((x) => [x.id, x.conversation_parts.conversation_parts.length]), [["1", 1], ["2", 1], ["3", 1]]);
  assert.equal(m.seen[0].headers["intercom-version"], "2.11");
  noToken(t, out, r);
});

test("hubspot: CRM objects paged with after", async (t) => {
  const dir = tmp(t);
  const m = await mock((url) => {
    const o = /^\/crm\/v3\/objects\/(\w+)$/.exec(url.pathname);
    if (o) return url.searchParams.get("after") ? [200, { results: [{ id: "3", properties: { o: o[1] } }] }] : [200, { results: [{ id: "1" }, { id: "2" }], paging: { next: { after: "2", link: "ignored" } } }];
  });
  t.after(m.close);
  const out = path.join(dir, "hs");
  const r = await cli(["pull", "hubspot", "--objects", "contacts,deals", "--base-url", m.base, "-o", out, "--quiet"], { OUTRICH_HUBSPOT_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(out, "contacts.jsonl").map((x) => x.id), ["1", "2", "3"]);
  assert.deepEqual(lines(out, "deals.jsonl").map((x) => x.id), ["1", "2", "3"]);
  assert.equal((await cli(["pull", "hubspot", "--objects", "../x", "--base-url", m.base, "-o", path.join(dir, "h2"), "--quiet"], { OUTRICH_HUBSPOT_TOKEN: TOKEN })).status, 2);
});

test("slack: channel list, history with cursors, thread replies, and an ok:false error", async (t) => {
  const dir = tmp(t);
  const m = await mock((url) => {
    const p = url.searchParams, method = url.pathname.replace("/api/", "");
    if (method === "conversations.list") return [200, { ok: true, channels: [{ id: "C1" }, { id: "C2" }], response_metadata: { next_cursor: "" } }];
    if (method === "conversations.history") {
      if (p.get("channel") === "C2") return [200, { ok: false, error: "not_in_channel" }];
      return p.get("cursor") ? [200, { ok: true, messages: [{ ts: "3.0", text: "three" }], has_more: false }]
        : [200, { ok: true, messages: [{ ts: "1.0", text: "one", thread_ts: "1.0", reply_count: 2 }, { ts: "2.0", text: "two" }], has_more: true, response_metadata: { next_cursor: "n2" } }];
    }
    if (method === "conversations.replies") return [200, { ok: true, messages: [{ ts: "1.0", text: "one" }, { ts: "1.1", text: "reply a" }, { ts: "1.2", text: "reply b" }] }];
  });
  t.after(m.close);
  const out = path.join(dir, "sl");
  const one = await cli(["pull", "slack", "--objects", "C1", "--base-url", m.base, "-o", out, "--quiet"], { OUTRICH_SLACK_TOKEN: TOKEN });
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(lines(out, "messages.jsonl").map((x) => [x.channel, x.ts]), [["C1", "1.0"], ["C1", "2.0"], ["C1", "3.0"]]);
  assert.deepEqual(lines(out, "replies.jsonl").map((x) => x.text), ["reply a", "reply b"]);
  const all = await cli(["pull", "slack", "--base-url", m.base, "-o", path.join(dir, "sl2"), "--quiet"], { OUTRICH_SLACK_TOKEN: TOKEN });
  assert.equal(all.status, 2);
  assert.match(all.stderr, /slack: conversations\.history failed: not_in_channel/);
});

test("convex and unknown systems make no request; run with a pull configured does the whole flow", async (t) => {
  const dir = tmp(t);
  const cx = await cli(["pull", "convex", "-o", path.join(dir, "cx"), "--quiet"]);
  assert.equal(cx.status, 2);
  assert.match(cx.stderr, /npx convex export/);
  assert.equal((await cli(["pull", "nosuch", "-o", path.join(dir, "n"), "--quiet"])).status, 2);
  const m = await mock((url) => {
    const o = /^\/crm\/v3\/objects\/(\w+)$/.exec(url.pathname);
    if (o) return [200, { results: [{ id: "1", properties: { firstname: "Zbigniew", lastname: "Kowalczyk", email: "z.kowalczyk@example.org", phone: "908 555 0142-office", notes: "Kowalczyk prefers email" } }] }];
  });
  t.after(m.close);
  const cfg = path.join(dir, "run.json");
  fs.writeFileSync(cfg, JSON.stringify({ pull: { system: "hubspot", baseUrl: m.base, objects: ["contacts"] }, output: "deal" }));
  const r = await cli(["run", cfg, "--quiet"], { OUTRICH_HUBSPOT_TOKEN: TOKEN });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const clean = read(dir, "deal", "clean", "contacts.jsonl");
  assert.equal(clean, '{"id":"1","properties":{"firstname":"[NAME_1]","lastname":"[NAME_2]","email":"[EMAIL_1]","phone":"[PHONE_1]","notes":"[NAME_2] prefers email"}}\n');
  const md = read(dir, "deal", "REPORT.md");
  assert.match(md, /Source: hubspot \(http:\/\/127\.0\.0\.1:\d+\), 1 records exported in 1 requests/);
  assert.match(md, /\| contacts\.jsonl \| 1 \|/);
  noToken(t, path.join(dir, "deal"), r);
});
