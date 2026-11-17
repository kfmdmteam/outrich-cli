// Synthetic support tickets for the benchmark and the end-to-end test. Every value is made up.
// ticket(i) is a pure function of i, so a test can rebuild any line and check what happened to it.
import fs from "node:fs";
import { once } from "node:events";

const FIRST = "James Mary Robert Patricia John Jennifer Michael Linda David Elizabeth William Barbara Richard Susan Joseph Jessica Thomas Sarah Daniel Karen Maria Carlos Sofia Diego Priya Arjun Wei Mei Aisha Omar Fatima Ahmed Emma Liam Olivia Noah Ava Lucas Hannah Ethan".split(" ");
const LAST = "Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young Allen King Wright Scott Torres Nguyen Patel Kim".split(" ");
const DOMAINS = "example.com example.org example.net mail.example.com corp.example.org".split(" ");
const SUBJECTS = ["Refund has not arrived", "Cannot log in to my account", "Wrong item in my delivery", "Invoice shows the wrong amount", "How do I change my plan?", "App crashes when I upload a photo", "Delivery is late", "Please cancel my subscription", "Charged twice this month", "Question about the warranty"];
const SENTENCES = [
  "I placed the order two weeks ago and it still shows as processing.",
  "The package arrived yesterday but the box was open and one part was missing.",
  "I already tried resetting my password twice and the link in the message does not work.",
  "Your help page says refunds take five business days, and it has been more than ten.",
  "I was charged the full price even though I entered the discount code at checkout.",
  "The tracking page has not changed since last Tuesday.",
  "I would like to keep the product, I only need the missing cable.",
  "This is the third time I am writing about the same problem.",
  "The app closes as soon as I open the camera screen on my phone.",
  "Could you tell me whether the replacement ships this week?",
  "I have attached a photo of the label and of the damaged corner.",
  "My colleague had the same issue last month and it was fixed within a day.",
  "Please confirm that the subscription will not renew next month.",
  "I do not need a replacement, a refund to the original payment method is fine.",
  "The invoice lists three units but we only ordered two.",
  "I looked for an answer in the help center and could not find one.",
  "It worked fine until the update that was installed over the weekend.",
  "We use the product every day, so a quick answer would help a lot.",
];
const CHANNELS = ["email", "chat", "web", "phone"], STATUS = ["open", "pending", "solved", "closed"], PRIORITY = ["low", "normal", "high"];
const TAGS = ["billing", "refund", "shipping", "login", "bug", "cancellation", "warranty", "feedback"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Assembled at run time so repository secret scanners do not flag this file. Not a real key.
const FAKE_KEY = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

/** The i-th ticket and the personal values planted in it. */
export function ticket(i) {
  const r = mulberry32(0x9e3779b9 ^ i), pick = (a) => a[Math.floor(r() * a.length)], int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const first = pick(FIRST), last = pick(LAST), agentFirst = pick(FIRST), agentLast = pick(LAST);
  const email = `${first}.${last}${int(1, 99)}@${pick(DOMAINS)}`.toLowerCase();
  const phone = `(${int(201, 989)}) 555-01${String(int(0, 99)).padStart(2, "0")}`;
  const order = `ORD-${int(100000, 999999)}`;
  const body = [`Hello,`];
  for (let n = int(2, 6); n > 0; n--) body.push(pick(SENTENCES));
  if (r() < 0.5) body.push(`My order number is ${order}.`);
  if (r() < 0.4) body.push(`You can reach me at ${email} or on ${phone}.`);
  const secret = i % 250 === 17;
  if (secret) body.push(`Our integration uses the key ${FAKE_KEY} in case you need it.`);
  const text = body.join(" ") + (r() < 0.6 ? `\n\nThanks,\n${first}` : "");
  const record = {
    id: `TCK-${String(i).padStart(9, "0")}`,
    created_at: new Date(Date.UTC(2024, 0, 1) + (i % 31_536_000) * 1000).toISOString(),
    channel: pick(CHANNELS), status: pick(STATUS), priority: pick(PRIORITY),
    customer: { name: `${first} ${last}`, email, phone },
    subject: pick(SUBJECTS), body: text,
    agent: `${agentFirst} ${agentLast}`,
    tags: [pick(TAGS), pick(TAGS)],
  };
  return { record, line: JSON.stringify(record), email, phone, name: `${first} ${last}`, secret };
}

/** Streams tickets to `path` until it holds at least `bytes`. Returns how many records were written. */
export async function writeTickets(path, bytes, from = 0, make = ticket) {
  const out = fs.createWriteStream(path);
  let written = 0, i = from;
  while (written < bytes) {
    const chunk = [];
    for (let size = 0; size < 1 << 20 && written + size < bytes; i++) { const l = make(i).line + "\n"; chunk.push(l); size += Buffer.byteLength(l); }
    const text = chunk.join("");
    written += Buffer.byteLength(text);
    if (!out.write(text)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
  return { records: i - from, bytes: written };
}

const STREETS = "MAPLE ST|HARBOR AVE|ELM ST|MORRIS AVE|BROAD ST|GROVE RD|PARK PL|UNION BLVD|CHESTNUT ST|HIGHLAND DR".split("|");
const RARE_FIRST = "Zbigniew Oluwaseun Thandiwe Ragnhild Bartholomew Anneliese".split(" "), RARE_LAST = "Kowalczyk Adeyemi Mthembu Haugland Featherstonehaugh Vanterpool".split(" ");

/** The i-th record of a made-up property inspection database: names and addresses sit in fields, often in capitals, and are not always in a name dictionary. */
export function property(i) {
  const r = mulberry32(0x51ed270b ^ i), pick = (a) => a[Math.floor(r() * a.length)], int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const rare = i % 3 === 0, first = rare ? pick(RARE_FIRST) : pick(FIRST), last = rare ? pick(RARE_LAST) : pick(LAST);
  const ownerName = `${last} ${first}`.toUpperCase(); // LASTNAME FIRSTNAME, as tax rolls write it
  const address = `${i % 4 === 0 ? `${int(1000, 3999)}-${int(11, 99)}` : int(1, 999)} ${pick(STREETS)}`;
  const tail = `555 01${String(int(0, 99)).padStart(2, "0")}`, area = int(201, 989);
  const phone = [`${area} ${tail}-office`, `(${area}) ${tail.replace(" ", " - ")}`, `${area}.${tail.replace(" ", ".")}E`, `${area}-${tail.replace(" ", "-")}(Mobile)`][i % 4];
  const engineer = `${pick(FIRST)} ${pick(RARE_LAST)}`, contact = `${pick(RARE_FIRST)} ${pick(LAST)}`;
  const email = `${first}.${last}@mail${i % 5 === 0 ? ".." : "."}example.com`.toLowerCase();
  const record = {
    _id: `k${((i * 2654435761) >>> 0).toString(36)}`, _creationTime: 1700000000000 + i * 1000, status: pick(["scheduled", "done", "invoiced"]), units: int(1, 40),
    ownerName, ownerPhone: phone, ownerEmail: email, address, addressKey: `${address}|LINDEN|NJ`.toLowerCase(),
    companyName: `${last} Realty LLC`, contactName: contact, engineerName: engineer,
    clients: [{ name: `${first} ${last}`, role: "owner" }, { name: contact, role: "manager" }],
    notes: `Spoke with ${first} ${last} at ${address}, NJ 07036 ${phone}. Send report to ${email}. Inspector ${engineer} on site.`,
  };
  return { record, line: JSON.stringify(record), ownerName, address, phone, email, first, last, engineer, contact };
}
