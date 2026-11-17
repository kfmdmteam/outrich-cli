// Connectors: the only code in this tool that uses the network. It is built into its own file
// (dist/connectors.mjs) and loaded only by `outrich pull` and by `outrich run` when a pull is configured.
//
// Rules every connector follows:
//  - The token comes from an environment variable. It is sent in a request header and nowhere else:
//    never printed, never put in a URL, never written to disk.
//  - Requests go to one origin, the host the user configured for that system. Any other URL, a
//    pagination link included, is refused, and redirects are not followed.
//  - Plain http is accepted only for localhost (tests).
// BETA: written against the vendors' published API shapes and tested with local mock servers.
import fs from "node:fs";
import path from "node:path";

export type PullConfig = { system: string; target?: string; baseUrl?: string; since?: string; query?: string; objects?: string[] };
type Json = Record<string, any>;
type Page = { items: Json[]; next: string | null };

const env = (name: string, required = true) => {
  const v = process.env[name];
  if (!v && required) throw new Error(`Set ${name} in the environment. Tokens are never taken from command line flags.`);
  return v ?? "";
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const MAX_WAIT_MS = Number(process.env.OUTRICH_MAX_WAIT_MS ?? 120_000);

/** All requests of one pull go through here. */
export class Client {
  readonly origin: string;
  requests = 0;
  constructor(private base: string, private headers: Record<string, string>, private label: string) {
    const u = new URL(base);
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error(`${label}: only https is allowed (got ${u.protocol}//${u.host}).`);
    this.origin = u.origin;
  }
  async get(urlOrPath: string): Promise<{ json: Json; headers: Headers }> {
    const u = new URL(urlOrPath, this.base);
    if (u.origin !== this.origin) throw new Error(`${this.label}: refused to contact ${u.origin}. Only ${this.origin}, the host configured for this pull, is allowed.`);
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const res = await fetch(u, { headers: this.headers, redirect: "error" });
      const limited = res.status === 429 || res.status === 503 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
      if (limited && attempt < 8) {
        // Retry-After in seconds, or GitHub's reset time, or exponential backoff.
        const after = Number(res.headers.get("retry-after")), reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = Number.isFinite(after) && res.headers.has("retry-after") ? after * 1000 : reset ? reset * 1000 - Date.now() : 1000 * 2 ** attempt;
        await res.arrayBuffer().catch(() => {});
        await sleep(Math.min(Math.max(wait, 0), MAX_WAIT_MS));
        continue;
      }
      if (!res.ok) throw new Error(`${this.label}: the API answered ${res.status} for ${u.pathname}. ${(await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ")}`);
      return { json: (await res.json()) as Json, headers: res.headers };
    }
  }
}

/** Appends pages to JSONL files and keeps a checkpoint, so an interrupted pull continues where it stopped. */
class Sink {
  private state: { key: string; cursors: Record<string, string | null>; done: string[]; sizes: Record<string, number>; records: Record<string, number> };
  private file: string;
  constructor(private dir: string, key: string, resume: boolean) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, ".outrich-pull.json");
    let saved: any = null;
    if (resume && fs.existsSync(this.file)) try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { /* unreadable: start over */ }
    if (saved && saved.key !== key) throw new Error(`${this.file} belongs to a different pull. Delete it, or run without --resume.`);
    this.state = saved ?? { key, cursors: {}, done: [], sizes: {}, records: {} };
    // Cut each file back to its size at the last checkpoint: a page that was half written is fetched again.
    for (const [name, size] of Object.entries(this.state.sizes)) if (fs.existsSync(this.path(name))) fs.truncateSync(this.path(name), size);
    if (!saved && fs.readdirSync(dir).some((f) => f.endsWith(".jsonl"))) throw new Error(`${dir} already holds .jsonl files. Pull into an empty folder, or use --resume to continue an interrupted pull.`);
  }
  private path(name: string) { return path.join(this.dir, `${name}.jsonl`); }
  write(name: string, items: Json[]) {
    if (items.length) fs.appendFileSync(this.path(name), items.map((x) => JSON.stringify(x) + "\n").join(""));
    this.state.records[name] = (this.state.records[name] ?? 0) + items.length;
  }
  /** Follows a paginated list to its end. `each` runs for every page before the checkpoint is saved. */
  async drain(stream: string, name: string | null, page: (cursor: string | null) => Promise<Page>, each?: (items: Json[]) => Promise<void>) {
    if (this.state.done.includes(stream)) return;
    let cursor = this.state.cursors[stream] ?? null;
    for (;;) {
      const p = await page(cursor);
      if (name) this.write(name, p.items);
      if (each) await each(p.items);
      cursor = p.next;
      this.state.cursors[stream] = cursor;
      if (!cursor) this.state.done.push(stream);
      this.checkpoint();
      if (!cursor) return;
    }
  }
  /** A list small enough to fetch in full between checkpoints (the comments of one ticket). */
  async all(page: (cursor: string | null) => Promise<Page>): Promise<Json[]> {
    const out: Json[] = [];
    for (let cursor: string | null = null; ; ) { const p = await page(cursor); out.push(...p.items); cursor = p.next; if (!cursor) return out; }
  }
  private checkpoint() {
    for (const name of Object.keys(this.state.records)) this.state.sizes[name] = fs.existsSync(this.path(name)) ? fs.statSync(this.path(name)).size : 0;
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.state));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  finish() { fs.rmSync(this.file, { force: true }); return Object.entries(this.state.records).map(([name, records]) => ({ file: `${name}.jsonl`, records })); }
}

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const q = encodeURIComponent;
const need = (c: PullConfig, what: string) => { if (!c.target && !c.baseUrl) throw new Error(`${c.system}: --target is required (${what}).`); return c.target ?? ""; };

/* Zendesk. Incremental ticket export, cursor based, then the comments of each ticket.
   https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/ */
async function zendesk(c: PullConfig, s: Sink) {
  const sub = need(c, "your Zendesk subdomain"), email = env("OUTRICH_ZENDESK_EMAIL", false), token = env("OUTRICH_ZENDESK_TOKEN");
  const api = new Client(c.baseUrl ?? `https://${sub}.zendesk.com`, { authorization: email ? basic(`${email}/token`, token) : `Bearer ${token}`, accept: "application/json" }, "zendesk");
  const start = c.since ? Math.floor(new Date(c.since).getTime() / 1000) : 0;
  await s.drain("tickets", "tickets", async (cursor) => {
    const { json } = await api.get(`/api/v2/incremental/tickets/cursor.json?${cursor ? `cursor=${q(cursor)}` : `start_time=${start}`}`);
    return { items: json.tickets ?? [], next: json.end_of_stream || !json.after_cursor ? null : json.after_cursor };
  }, async (tickets) => {
    for (const t of tickets) s.write("ticket_comments", (await s.all(async (cursor) => {
      const { json } = await api.get(`/api/v2/tickets/${t.id}/comments.json?page[size]=100${cursor ? `&page[after]=${q(cursor)}` : ""}`);
      return { items: (json.comments ?? []).map((x: Json) => ({ ticket_id: t.id, ...x })), next: json.meta?.has_more ? json.meta.after_cursor : null };
    })));
  });
  return api;
}

/* GitHub. Issues (which include pull requests), pull requests, and their comments, for one repository or every repository of an organization.
   Pagination follows the Link header. https://docs.github.com/en/rest/issues/issues */
async function github(c: PullConfig, s: Sink) {
  const target = need(c, "owner/repo, or an organization name");
  const api = new Client(c.baseUrl ?? "https://api.github.com", { authorization: `Bearer ${env("OUTRICH_GITHUB_TOKEN")}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "outrich-cli" }, "github");
  const linked = (first: string) => async (cursor: string | null): Promise<Page> => {
    const { json, headers } = await api.get(cursor ?? first);
    return { items: Array.isArray(json) ? json : [], next: /<([^<>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1] ?? null };
  };
  const repos = target.includes("/") ? [target] : (await s.all(linked(`/orgs/${q(target)}/repos?per_page=100`))).map((r) => r.full_name as string);
  for (const r of repos) {
    const name = (kind: string) => `${r.replace("/", "__")}.${kind}`;
    await s.drain(`${r}:issues`, name("issues"), linked(`/repos/${r}/issues?state=all&per_page=100`));
    await s.drain(`${r}:pulls`, name("pulls"), linked(`/repos/${r}/pulls?state=all&per_page=100`));
    await s.drain(`${r}:issue_comments`, name("issue_comments"), linked(`/repos/${r}/issues/comments?per_page=100`));
    await s.drain(`${r}:review_comments`, name("review_comments"), linked(`/repos/${r}/pulls/comments?per_page=100`));
  }
  return api;
}

/* Jira Cloud. Issues by JQL search with nextPageToken, then the comments of each issue.
   https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/ */
async function jira(c: PullConfig, s: Sink) {
  const site = need(c, "your Atlassian site name, the part before .atlassian.net");
  const api = new Client(c.baseUrl ?? `https://${site}.atlassian.net`, { authorization: basic(env("OUTRICH_JIRA_EMAIL"), env("OUTRICH_JIRA_TOKEN")), accept: "application/json" }, "jira");
  const jql = c.query ?? `created >= "${c.since ?? "1970-01-01"}" order by created asc`;
  await s.drain("issues", "issues", async (cursor) => {
    const { json } = await api.get(`/rest/api/3/search/jql?jql=${q(jql)}&maxResults=100&fields=*all${cursor ? `&nextPageToken=${q(cursor)}` : ""}`);
    return { items: json.issues ?? [], next: json.nextPageToken ?? null };
  }, async (issues) => {
    for (const i of issues) s.write("issue_comments", await s.all(async (cursor) => {
      const at = Number(cursor ?? 0), { json } = await api.get(`/rest/api/3/issue/${q(i.key)}/comment?startAt=${at}&maxResults=100`);
      const got = json.comments ?? [];
      return { items: got.map((x: Json) => ({ issue_key: i.key, ...x })), next: got.length && at + got.length < (json.total ?? 0) ? String(at + got.length) : null };
    }));
  });
  return api;
}

/* Intercom. Conversations are listed with a cursor, then each is fetched in full for its parts.
   https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations */
async function intercom(c: PullConfig, s: Sink) {
  const api = new Client(c.baseUrl ?? "https://api.intercom.io", { authorization: `Bearer ${env("OUTRICH_INTERCOM_TOKEN")}`, accept: "application/json", "intercom-version": "2.11" }, "intercom");
  let full: Json[] = [];
  await s.drain("conversations", null, async (cursor) => {
    const { json } = await api.get(`/conversations?per_page=50${cursor ? `&starting_after=${q(cursor)}` : ""}`);
    return { items: json.conversations ?? [], next: json.pages?.next?.starting_after ?? null };
  }, async (list) => {
    full = [];
    for (const item of list) full.push((await api.get(`/conversations/${q(String(item.id))}`)).json);
    s.write("conversations", full);
  });
  return api;
}

/* HubSpot. CRM objects, paged with `after`. https://developers.hubspot.com/docs/api/crm/understanding-the-crm */
async function hubspot(c: PullConfig, s: Sink) {
  const api = new Client(c.baseUrl ?? "https://api.hubapi.com", { authorization: `Bearer ${env("OUTRICH_HUBSPOT_TOKEN")}`, accept: "application/json" }, "hubspot");
  for (const o of c.objects ?? ["contacts", "companies", "deals", "tickets"]) {
    if (!/^[\w-]+$/.test(o)) throw new Error(`hubspot: "${o}" is not an object type name.`);
    await s.drain(o, o, async (cursor) => {
      const { json } = await api.get(`/crm/v3/objects/${o}?limit=100${cursor ? `&after=${q(cursor)}` : ""}`);
      return { items: json.results ?? [], next: json.paging?.next?.after ?? null };
    });
  }
  return api;
}

/* Slack. History and thread replies of every channel the token can read (or the channel IDs given).
   https://api.slack.com/methods/conversations.history */
async function slack(c: PullConfig, s: Sink) {
  const api = new Client(c.baseUrl ?? "https://slack.com", { authorization: `Bearer ${env("OUTRICH_SLACK_TOKEN")}`, accept: "application/json" }, "slack");
  const call = (method: string, params: string, key: string) => async (cursor: string | null): Promise<Page> => {
    const { json } = await api.get(`/api/${method}?${params}&limit=200${cursor ? `&cursor=${q(cursor)}` : ""}`);
    if (!json.ok) throw new Error(`slack: ${method} failed: ${String(json.error).slice(0, 80)}`);
    return { items: json[key] ?? [], next: json.response_metadata?.next_cursor || null };
  };
  const channels = c.objects ?? (await s.all(call("conversations.list", "types=public_channel,private_channel", "channels"))).map((ch) => ch.id as string);
  for (const ch of channels) {
    await s.drain(`history:${ch}`, "messages", async (cursor) => {
      const p = await call("conversations.history", `channel=${q(ch)}`, "messages")(cursor);
      return { items: p.items.map((m) => ({ channel: ch, ...m })), next: p.next };
    }, async (messages) => {
      for (const m of messages) if (m.reply_count > 0 && m.thread_ts === m.ts)
        s.write("replies", (await s.all(call("conversations.replies", `channel=${q(ch)}&ts=${q(m.ts)}`, "messages"))).filter((r) => r.ts !== m.ts).map((r) => ({ channel: ch, ...r })));
    });
  }
  return api;
}

const SYSTEMS: Record<string, (c: PullConfig, s: Sink) => Promise<Client>> = { zendesk, github, jira, intercom, hubspot, slack };
export const systems = [...Object.keys(SYSTEMS), "convex"];

/** Exports one system to JSONL files under `dir`. Returns what was written. */
export async function pull(c: PullConfig, dir: string, resume: boolean) {
  if (c.system === "convex") throw new Error("Convex needs no connector. Export a snapshot with your own credentials (npx convex export --path snapshot.zip), then run: outrich run snapshot.zip");
  const run = SYSTEMS[c.system];
  if (!run) throw new Error(`Unknown system "${c.system}". Known: ${systems.join(", ")}.`);
  const sink = new Sink(dir, JSON.stringify([c.system, c.target ?? "", c.baseUrl ?? "", c.since ?? "", c.query ?? "", c.objects ?? []]), resume);
  const api = await run(c, sink);
  return { system: c.system, host: api.origin, requests: api.requests, files: sink.finish() };
}
