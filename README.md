# outrich

Local command line data tools from [Outrich Data](https://outrichdata.com).

`outrich` prepares company data for licensing or delivery: it removes personal data by field and inside free text, checks what is left, scans for leaked credentials, builds and verifies delivery manifests, and writes one report of what it did. It does the same work as the free browser tools at https://outrichdata.com/tools, for data that is too large for a browser tab.

- It runs on your machine. Every command except `pull` works with the network switched off.
- Memory use does not grow with input size. Files are streamed, never loaded whole.
- It has no runtime dependencies. The program is built from the TypeScript in this repository, so you can read what you run.

Outrich Data buys company data directly from the companies that own it, and runs escrow for data deals. It is a direct buyer, never a broker. This tool is free and open source under the MIT license, and you do not need to deal with Outrich Data to use it.

## Install

Requires Node.js 20 or later.

```
npx github:kfmdmteam/outrich-cli --help
```

Or build from source:

```
git clone https://github.com/kfmdmteam/outrich-cli
cd outrich-cli
npm install
npm run build
node dist/outrich.mjs --help
```

`npm link` puts `outrich` on your PATH. Publishing to the npm registry is pending; until then, use one of the two ways above.

## The short version

```
outrich run export/
```

That one command samples the data and writes a field policy, scrubs with it, re-scans the result, scans for credentials, profiles the clean data, builds a manifest, and writes `REPORT.md` and `outrich-report.json`. Each step is also a command of its own, described below. All examples are real runs on synthetic data (made by `scripts/gen.mjs`) on the machine described in [BENCH.md](BENCH.md).

```
$ outrich run export
[run] plan
[run] scrub
[run] secrets
[run] profile
[run] manifest
Run complete.
  plan       ok       1.0s
  scrub      ok       2.9s
  secrets    ok       0.2s
  profile    ok       1.0s
  manifest   ok       0.2s
Manifest hash: 0b138d618abda3c62172870d8d2493fde4518e60be48bece5f8e46d9c0d84257
Clean data: D:\outrich-tmp\demo2\export-outrich\clean
Report: D:\outrich-tmp\demo2\export-outrich\REPORT.md and outrich-report.json
```

The output folder (`<input>-outrich` unless a config says otherwise) holds `clean/`, `policy.json`, `scrub-report.json`, `secrets.jsonl`, `manifest.json`, `outrich-report.json` and `REPORT.md`. The report is written for a seller to hand to counsel and to an escrow agent. It starts like this:

```
# Data preparation report

- Status: complete
- Produced by: outrich 0.1.0, on 2026-11-17T16:29:58.952Z
- Source: D:\outrich-tmp\demo2\export
- Clean data: D:\outrich-tmp\demo2\export-outrich\clean
- Manifest hash (SHA-256): `0b138d618abda3c62172870d8d2493fde4518e60be48bece5f8e46d9c0d84257`

## What was removed

- Files: 2
- Records: 62,600
- Size in: 38.1 MB. Size out: 32.6 MB
- Replacements: 660,366
- Mode: label
- Policy: D:\outrich-tmp\demo2\export-outrich\policy.json (SHA-256 `3ed308f0bdfe3cb4abe5193b8c7342a9bf2afce8f150a9c08a0513d0ee01d10b`)

| Field | Removed |
| --- | --- |
| ownerName | NAME 31,980 |
| ownerPhone | PHONE 31,980 |
| address | ADDRESS 31,980 |
| clients[].name | NAME 63,960 |
| notes | TEXT 31,980 |
```

It goes on with the residual check, the credentials scan, the size of the clean data and the manifest. It holds counts and the shapes of values, never a removed value.

`run` stops with a nonzero exit code, before the manifest, when the residual check or the credentials scan finds something. `--allow-findings` makes it continue. The argument can be a folder, a `.zip`, or a JSON config:

```json
{ "input": "export", "output": "deal-123", "policy": "reviewed-policy.json" }
```

`input`, `output` and `policy` are relative to the config file. With `"policy"` the plan step is skipped and your reviewed policy is used. A config can name a system to export from in place of `input` (see `pull`).

## Detection, stated plainly

Detection uses field names, regular expressions, checksums (Luhn, mod-97, check digits) and a name dictionary. It is not a trained model. **It reduces the personal data in a dataset. It does not guarantee removal.** Unusual names in free text, free-form addresses and identifiers with no recognizable shape can get through. The residual check lowers that risk and does not remove it: it uses the same kinds of rules, so what the rules cannot see, the check cannot see either. Have a person sample the clean data before it is shared or licensed.

## Commands

### plan

```
outrich plan <file|dir|zip> -o policy.json
```

Reads the first 4 MB of every file and writes a policy: each field path, what was detected in it, how often it is filled, a sample with every letter and digit hidden, a suggested action, and the reason for it.

```
$ outrich plan export -o policy.json
Sampled 13,109 records from 2 files. 26 field paths.
  field                          action         filled  sample (letters, digits hidden)   why
  _creationTime                  keep              51%  9999999999999                     numbers only, nothing detected in the sample
  _id                            keep              51%  a9                                short values without spaces, nothing detected in the sample
  address                        scrub ADDRESS     51%  9999-99 AAAAA AA                  field name says ADDRESS
  addressKey                     scrub ADDRESS     51%  9999-99 aaaaa aa|aaaaaa|aa        field name says ADDRESS
  agent                          scrub NAME        49%  Aaaaa Aaaaaa                      field name says NAME
  body                           text              49%  Aaaaa, Aaaaa aaa aaaa aa aaaaaaa  free text: the detectors decide; ID, NAME, EMAIL, PHONE seen in the sample
  channel                        keep              49%  aaa                               short values without spaces, nothing detected in the sample
  clients[].name                 scrub NAME       100%  Aaaaaaaaa Aaaaaaa                 name under "clients": a person
  clients[].role                 keep             100%  aaaaa                             short values without spaces, nothing detected in the sample
  companyName                    scrub NAME        51%  Aaaaaaa Aaaaaa AAA                field name says NAME
  contactName                    scrub NAME        51%  Aaaaaaaaa Aaaaaaaaa               field name says NAME
  created_at                     keep              49%  9999-99-99A99:99:99.999A          short values without spaces, nothing detected in the sample
  customer.email                 scrub EMAIL       49%  aaaaaa.aaaaaaaa9@aaaaaaa.aaa      field name says EMAIL
  customer.name                  scrub NAME        49%  Aaaaaa Aaaaaaaa                   name under "customer": a person
  customer.phone                 scrub PHONE       49%  (999) 999-9999                    field name says PHONE
  engineerName                   scrub NAME        51%  Aaaaaa Aaaaaaa                    field name says NAME
  id                             keep              49%  AAA-999999999                     short values without spaces, nothing detected in the sample
  notes                          text              51%  Aaaaa aaaa Aaaaaaaaa Aaaaaaa aa   free text: the detectors decide; NAME, ADDRESS, PHONE, EMAIL seen in the sample
  ownerEmail                     scrub EMAIL       51%  aaaaaaaaa.aaaaaaa@aaaa..aaaaaaa.  field name says EMAIL
  ownerName                      scrub NAME        51%  AAAAAAA AAAAAAAAA                 field name says NAME
  ownerPhone                     scrub PHONE       51%  999 999 9999-aaaaaa               field name says PHONE
  priority                       keep              49%  aaa                               short values without spaces, nothing detected in the sample
  status                         keep             100%  aaaaaa                            short values without spaces, nothing detected in the sample
  subject                        text              49%  Aaaaaa aaa aaa aaaaaaa            free text: the detectors decide
  tags[]                         keep              98%  aaaaaaaa                          short values without spaces, nothing detected in the sample
  units                          keep              51%  99                                numbers only, nothing detected in the sample
Policy: D:\outrich-tmp\demo2\policy.json
Review it, edit the actions (keep, scrub, text, hash, drop), then run: outrich scrub <input> -o <out> --policy policy.json
```

The policy is a JSON file meant to be read and edited. The actions:

| Action | Meaning |
|---|---|
| `scrub` (with a `type`) | The whole value is replaced as that type: `"ownerName": "[NAME_1]"`. |
| `text` | The detectors run inside the value and replace what they find. For free text. |
| `hash` | The whole value becomes a stable salted token. For IDs you want to join on later. |
| `drop` | The field is removed. |
| `keep` | The value is left as it is. |

Paths are dotted, with `[]` for arrays: `customer.name`, `clients[].name`. A CSV column is a path. `keep` is a suggestion from a sample: a field that only held short codes in the first 4 MB can hold something else further down, which is one reason the residual check exists.

### scrub

```
outrich scrub <file|dir|zip> -o <out> [--policy policy.json] [--strict]
```

Replaces personal data. Given a folder or a `.zip`, it walks the whole tree and writes the same tree under the output folder. Records stay in their original order.

```
$ outrich scrub export -o clean --policy policy.json
Scrubbed 2 files, 38.1 MB, 62,600 records in 1.8s (21.1 MB/s, 11 workers).
Replacements: 660,366
  NAME         335,387
  PHONE        106,886
  EMAIL        106,886
  ADDRESS      95,940
  ID           15,267
By field:
  ownerName                    NAME 31,980
  ownerPhone                   PHONE 31,980
  ownerEmail                   EMAIL 31,980
  address                      ADDRESS 31,980
  addressKey                   ADDRESS 31,980
  companyName                  NAME 31,980
  contactName                  NAME 31,980
  engineerName                 NAME 31,980
  clients[].name               NAME 63,960
  notes                        TEXT 31,980
  customer.name                NAME 30,620
  customer.email               EMAIL 30,620
  customer.phone               PHONE 30,620
  agent                        NAME 30,620
  body                         TEXT 26,948
Residual check: 62,600 records in 2 files re-scanned.
  Nothing that looks like personal data was found.
Residual check PASS: EMAIL, PHONE, SSN and CARD are each at or under 0.
Output: D:\outrich-tmp\demo2\clean
Report: D:\outrich-tmp\demo2\clean.scrub-report.json
Detection is pattern and dictionary based. Sample the output before you rely on it.
```

One record before and after (synthetic):

```
{"_id":"kxjaz0k","_creationTime":1700000004000,"status":"scheduled","units":9,"ownerName":"ROBINSON MARIA","ownerPhone":"892 555 0125-office","ownerEmail":"maria.robinson@mail.example.com","address":"1702-94 PARK PL","addressKey":"1702-94 park pl|linden|nj","companyName":"Robinson Realty LLC","contactName":"Ragnhild Martin","engineerName":"John Mthembu","clients":[{"name":"Maria Robinson","role":"owner"},{"name":"Ragnhild Martin","role":"manager"}],"notes":"Spoke with Maria Robinson at 1702-94 PARK PL, NJ 07036 892 555 0125-office. Send report to maria.robinson@mail.example.com. Inspector John Mthembu on site."}

{"_id":"kxjaz0k","_creationTime":1700000004000,"status":"scheduled","units":9,"ownerName":"[NAME_1]","ownerPhone":"[PHONE_1]","ownerEmail":"[EMAIL_1]","address":"[ADDRESS_1]","addressKey":"[ADDRESS_2]","companyName":"[NAME_2]","contactName":"[NAME_3]","engineerName":"[NAME_4]","clients":[{"name":"[NAME_1]","role":"owner"},{"name":"[NAME_3]","role":"manager"}],"notes":"Spoke with [NAME_1] at [ADDRESS_1], NJ 07036 [PHONE_2]-office. Send report to [EMAIL_1]. Inspector [NAME_4] on site."}
```

**How a record is handled.** For JSON Lines and CSV or TSV, each record is parsed and every value is decided by its field path:

1. If a policy lists the path, the policy decides.
2. Otherwise the field name decides. A name such as `ownerName`, `contact_name`, `customer`, `address`, `addressKey`, `ownerPhone`, `phone10`, `email`, `ssn`, `dob`, `passportNumber`, `cardNumber`, `iban`, `accountNumber` or `password` means the whole value is replaced as that type, whatever it looks like. Digits and plurals in a key do not matter: `phone10`, `phone_e164`, `phoneNumber2`, `cellPhone` and `phones` are all phone fields.
3. Every other string or number goes to the free-text detectors, with its field name as context.

**Name fields are replaced whole, with one label.** A value under a key that says owner or person name becomes a single `[NAME_n]`, whether it is one person (`KOWALCZYK ZBIGNIEW`), several owners (`KOWALCZYK ZBIGNIEW & THANDIWE`), an entity (`HAUGLAND REALTY LLC`) or a company named after a street address (`418 MAPLE LLC`). No words are left after the label. Only a value over 200 characters is treated as free text. A person's name found this way is also removed where it appears in the free text of the same record, in either word order; the words of an entity or address-style value are not learned, so "main" is not removed from the notes because the owner is `MAIN STREET HOLDINGS LLC`.

**A field called just `name`** can hold a person or a thing, so where it sits decides:

- The nearest enclosing field that names a person (`client`, `customer`, `contact`, `owner`, `user`, `person`, `employee`, `tenant` and similar) makes it a person; one that names a thing (`item`, `lineItems`, `product`, `service`, `template`, `table`, `file`, `attachment`, `plan`, `category`, `project` and similar) makes it a thing. The file or folder name counts as the outermost level, so `clients/documents.jsonl` and `templates/documents.jsonl` are told apart.
- Failing that, the fields beside it: `price`, `quantity`, `sku`, `unit`, `mime`, `size` and similar mean a thing; an email, phone or address field means a person.
- A thing is read by the free-text detectors without its key, so a product called "Annual Roof Inspection" is left alone while a dictionary name inside a product name is still caught. With nothing to go on, the detectors read the value under the key `name`, which treats capitalized words as a name.

`plan` prints the decision and its reason for every field. Nested objects and arrays are walked. A line with nothing to change is written back byte for byte.

Plain text files are scrubbed one line at a time by the detectors alone.

`--strict` makes scrub fail when the data holds a field path the policy does not list, so that a new column cannot slip through unreviewed. The audit report records the SHA-256 of the policy's rules.

**The 21 identifier types:** email addresses, phone numbers, names, street addresses, dates of birth, US Social Security numbers, US tax IDs, UK and Canadian national IDs, passport numbers, driver's license numbers, payment cards, IBANs, bank account and routing numbers, crypto wallet addresses, API keys and passwords, IP addresses, MAC addresses, vehicle identification numbers, account and customer IDs, URLs (off by default in free text), and your own terms.

**Options.**

| Option | Meaning |
|---|---|
| `--policy FILE` | Field policy from `outrich plan`. |
| `--strict` | Fail on a field path the policy does not list. |
| `--no-audit` | Skip the residual check that runs when scrubbing ends. |
| `--max-residual N` | How many residual EMAIL, PHONE, SSN or CARD values the check tolerates. Default 0. |
| `--mode label` | Default. `dana@acme.com` becomes `[EMAIL_1]`. |
| `--mode mask` | Keeps the shape: `d***@a***.com`. |
| `--mode hash` | A stable token: `[EMAIL_4cfd0afad4]`. Use `--salt`. |
| `--mode synthetic` | Made-up values of the same kind. The residual check is skipped in this mode. |
| `--mode remove` | Deletes the value. |
| `--salt S` | Salt for hash and synthetic modes. `OUTRICH_SALT` in the environment works too and keeps the salt out of your shell history. |
| `--names context\|balanced\|aggressive` | How readily a capitalized word in free text is treated as a name. Default `balanced`. |
| `--types LIST` | Comma-separated types for the free-text detectors. |
| `--report PATH` | Where the audit report goes. Default `<out>.scrub-report.json`. |

**What is consistent, and what is not.** Every record is scrubbed on its own. Nothing learned in one record is used in another. This is what lets the work be split across cores with flat memory, and it means the output is the same whether you use 1 worker or 64. The tests check that.

- Within one record, the same value gets the same replacement in every field, and "Lee Dana" and "Dana Lee" share one.
- In `label` mode the numbers restart with each record. `[EMAIL_1]` in one record and `[EMAIL_1]` in the next are not the same address. Numbering that runs across records and files would need a table of every value seen, shared by all workers, which grows with the data. It is not offered.
- In `hash` mode the token depends only on the salt and the value, so the same email, phone, name or ID gets the same token in every field, record, file and run with that salt. **Use `--mode hash --salt ...` when the same value must map to the same label across a dataset.**
- A name is not carried from one record to the next. A name that appears only in the free text of a later record, with no cue next to it and not in the dictionary, is not known there.
- The hash is 64-bit FNV-1a. It is not cryptographic. Someone who knows the salt, or who can guess candidate values when there is no salt, can test guesses against the tokens.

**The audit report** (`<out>.scrub-report.json`) has counts per type, per detection rule and per field, files, bytes, records, duration, tool and engine version, the options and policy hash, and the result of the residual check. It never contains a removed value, and it records only whether a salt was set.

### audit

```
outrich audit <file|dir> [--policy policy.json] [--max-residual N]
```

Scans data that has already been scrubbed and reports what still looks like personal data, per field path and type, with counts and shape-only samples. It applies both the detectors and the field-name rules: a value in a field called `ownerName` that is not a replacement token is reported even when no pattern matches it. `scrub` runs this on its own output when it finishes.

The exit code is 2 when EMAIL, PHONE, SSN or CARD is over `--max-residual` (default 0). Other types are listed for a person to review and do not fail the check, because name and address detection in free text has false positives. On raw data it looks like this:

```
$ outrich audit export
Residual check: 62,600 records in 2 files re-scanned.
  field                        type             count  shape of what was found
  clients[].name               NAME            63,960  Aaaaaaaaa Aaaaaaa | Aaaaaaaaa Aaaaaaaaa | Aaaaa Aaaaa
  ownerName                    NAME            31,980  AAAAAAA AAAAAAAAA | AAAAA AAAAA | AAAAAAAAAA AAAAAAAAA
  ownerPhone                   PHONE           31,980  999 999 9999-aaaaaa | (999) 999 - 9999 | 999.999.9999A
  ownerEmail                   EMAIL           31,980  aaaaaaaaa.aaaaaaa@aaaa..aaaaaaa.aaa | aaaaa.aaaaa@aaaa.aaaaaaa.aaa
  address                      ADDRESS         31,980  9999-99 AAAAA AA | 999 AAAAA AA | 999 AAAAAAAA AA
  customer.phone               PHONE           30,620  (999) 999-9999
  ...
Residual check FAIL: EMAIL 106,886, PHONE 106,886 over the limit of 0.
```

(Rows trimmed.) A pass means the rules found nothing more. It is not proof that nothing is there.

### secrets

```
outrich secrets <file|dir|zip>
```

Scans for leaked credentials: cloud keys, payment and API keys, tokens, private key blocks, connection strings with passwords, and high-entropy strings next to words like `secret`. Findings go to stdout as JSON Lines. The exit code is 1 when anything is found, so it can gate a CI job.

```
$ outrich secrets export | head -3
{"file":"notes/handover.txt","line":3,"column":28,"type":"db-connection-string","severity":"critical","preview":"Xk29******Tz","placeholder":false}
{"file":"tickets-2025.jsonl","line":18,"column":593,"type":"stripe-key","severity":"critical","preview":"sk_l************dc","placeholder":false}
{"file":"tickets-2025.jsonl","line":268,"column":510,"type":"stripe-key","severity":"critical","preview":"sk_l************dc","placeholder":false}
```

The summary goes to stderr (`491 possible secrets in 3 of 4 files (critical 491, high 0, medium 0, low 0). 0 files skipped.`). The secret itself is never printed, only a masked preview. In a folder, dependency folders, lockfiles, minified files and binary files are skipped. A finding marked `"placeholder": true` looks like a documented example. It still counts toward the exit code.

### manifest and verify

```
outrich manifest <dir|zip> -o manifest.json
outrich verify <dir|zip> <manifest.json>
```

`manifest` computes the SHA-256 of every file, of any size, and writes paths, sizes, checksums, line counts for line-based files, and one manifest hash over the whole list.

```
$ outrich manifest clean -o manifest.json
Manifest: D:\outrich-tmp\demo\manifest3.json
Files: 4  Size: 72.0 MB (75,504,110 bytes)  Time: 0.4s (197.3 MB/s)
Manifest hash: ff14615d198c04b8accd6ce01d971ce2f116de8a2dd7d333df44c98c5bc37709
```

The file is the same format, byte for byte, as the manifest made by the delivery tools on outrichdata.com and used in the Outrich Data escrow deal room, and the manifest hash is computed the same way. A seller can build the manifest here for a delivery of any size and post it in the deal room, and the buyer can verify with either tool. A test compares the file this command writes with the output of the website's own `buildManifest` function.

`verify` hashes the folder again. Each file is `match`, `mismatch` (same size, different content), `size`, `missing` or `extra`. The exit code is 0 only when every listed file matches and there are no extra files.

```
$ outrich verify clean manifest.json
Manifest hash: ff14615d198c04b8accd6ce01d971ce2f116de8a2dd7d333df44c98c5bc37709
match 4  mismatch 0  size 0  missing 0  extra 0
PASS: every file in the manifest is present with the same size and SHA-256, and there are no extra files.
```

After one file was changed, one removed and one added:

```
$ outrich verify clean manifest.json
Manifest hash: ff14615d198c04b8accd6ce01d971ce2f116de8a2dd7d333df44c98c5bc37709
match 2  mismatch 0  size 1  missing 1  extra 1
  missing  customers.csv
  size     notes/handover.txt
  extra    stray.txt
FAIL: the folder does not match the manifest.
```

A manifest that was edited after it was created no longer matches its own hash and is refused. A matching checksum shows that the bytes are identical. It says nothing about the quality or lawfulness of the content.

### profile

```
outrich profile <file|dir|zip>
```

Records, bytes, approximate tokens (characters divided by four), how often each top-level field is filled, and personal data hits by type.

```
$ outrich profile export/tickets-2024.jsonl
Files: 1  Size: 47.7 MB  Records: 76,462  Approx. tokens: 12,500,035
Personal data hits (pattern and dictionary based):
  NAME         198,485
  EMAIL        107,213
  PHONE        107,213
  ID           38,254
  SECRET       306
Field coverage, tickets-2024.jsonl (76,462 records):
  id                       100.0%
  created_at               100.0%
  ...
```

### convert

```
outrich convert <in> -o <out>
```

CSV or TSV to JSON Lines, or JSON Lines to CSV or TSV. The direction comes from the file names. JSON Lines to CSV reads the file twice, once to collect every field name and once to write the rows, so no row is held in memory. A line that is not valid JSON is left out and counted, and the exit code is 1 when that happens.

```
$ outrich convert export/customers.csv -o customers.jsonl
Converted 20,000 records in 0.2s.
Output: D:\outrich-tmp\demo\customers.jsonl
```

### pull (beta)

```
outrich pull <system> -o <dir> [--target T] [--base-url U] [--since DATE] [--objects LIST] [--resume]
```

Exports from one of your own systems to JSON Lines files, using an API token that you create in that system's admin panel. **This is the only command that uses the network.**

**The connectors are beta.** They were written against the vendors' published API documentation and are tested against local mock servers that replay the documented response shapes (pagination, HTTP 429 with Retry-After, errors). They have not yet been run against live accounts on every plan and API version. Check the record counts of a pull against what the system itself shows before relying on it.

| System | Token (environment) | `--target` | What is exported |
|---|---|---|---|
| `zendesk` | `OUTRICH_ZENDESK_TOKEN`, and `OUTRICH_ZENDESK_EMAIL` for an API token (omit it for an OAuth token) | subdomain | Tickets (incremental cursor export) and each ticket's comments |
| `github` | `OUTRICH_GITHUB_TOKEN` | `owner/repo` or an organization | Issues, pull requests, issue comments, review comments |
| `jira` | `OUTRICH_JIRA_TOKEN` and `OUTRICH_JIRA_EMAIL` | site name (before `.atlassian.net`) | Issues by JQL search (`--query`), and each issue's comments |
| `intercom` | `OUTRICH_INTERCOM_TOKEN` | none | Conversations with their parts |
| `hubspot` | `OUTRICH_HUBSPOT_TOKEN` | none | CRM objects: `--objects contacts,companies,deals,tickets` |
| `slack` | `OUTRICH_SLACK_TOKEN` | none | Messages and thread replies of the channels the token can read (`--objects` for channel IDs) |
| `convex` | none | none | No connector. Run `npx convex export --path snapshot.zip` yourself, then `outrich run snapshot.zip`. |

Slack's official export ZIP also works without a connector: `outrich run slack-export.zip`.

How the connectors are fenced in:

- Tokens are read from environment variables only, never from flags. A token is sent in a request header and nowhere else. It is not printed, not put in a URL, and not written to any file. The tests check the output folder and the console for it.
- A pull contacts one origin: the vendor's API host for your account, or the `--base-url` you give. Any other URL is refused, including a pagination link that points elsewhere. Redirects are not followed. Plain http is refused except for localhost.
- HTTP 429 and 503 are retried after the `Retry-After` the server gives (GitHub's rate-limit reset header is honored too), with exponential backoff otherwise.
- A checkpoint file in the output folder records the cursor after each page. `--resume` continues an interrupted pull without duplicating records.
- The network code is in `src/connectors/`, built into its own file, `dist/connectors.mjs`. The main program does not contain it and loads it only for `pull`. Delete that file and every other command still works.

In a `run` config: `{ "pull": { "system": "zendesk", "target": "acme" }, "output": "deal-123" }`.

## Input formats

| Format | Handling |
|---|---|
| `.jsonl`, `.ndjson` | One JSON record per line. |
| `.csv`, `.tsv` | Quoted fields with line breaks are handled. Output is re-quoted, with `\n` line ends. |
| `.txt`, `.log`, `.md` | One line is one record. Line endings are kept. |
| `.json` | A document up to 64 MB. A top-level array becomes one record per element. Output is JSON Lines (`name.json.jsonl`). |
| `.mbox`, `.eml` | Mail, Google Takeout included. Each message becomes a record `{from, to, cc, date, subject, body, attachments}`. Quoted-printable and base64 are decoded, `text/plain` is preferred, HTML is reduced to text otherwise, and attachments are listed by name and not included. Output is JSON Lines (`name.mbox.jsonl`). |
| `.gz` of any of the above | Unpacked as it is read. A `.gz` output name packs as it is written. |
| `.zip` | `scrub`, `plan`, `profile`, `secrets`, `manifest`, `verify` and `run` read the entries directly, zip64 included. Encrypted archives are refused. |

## Common options

| Option | Meaning |
|---|---|
| `--workers N` | Worker threads. Default: logical CPU cores minus one. |
| `--resume` | `scrub`, `manifest` and `pull`: continue an interrupted run. |
| `--json` | Print the result as one JSON object on stdout. |
| `--quiet` | No progress and no notes on stderr. |

Progress (bytes done, bytes per second, time remaining) goes to stderr: redrawn in place on a terminal, one line every 10 seconds otherwise.

Exit codes: 0 success. 1 secrets found, verify found a difference, or convert left lines out. 2 wrong usage, a file could not be read or written, or the residual check failed.

**Resume.** While a folder run is in progress, a small state file (`.outrich-state.jsonl`, one line per finished file) is kept in the output folder for `scrub`, or next to the manifest for `manifest`. Run the same command again with `--resume`: files that were finished and have not changed are skipped, and their counts are still in the final report. The state file is removed when a run finishes without errors. A run with different options refuses to resume from it.

## How it scales

**Memory.** Input is read in blocks of about 256 KB that end on a record boundary. Blocks go to worker threads, and results come back in order through a window of bounded size. Reading pauses when the window is full, and writing waits for the disk. Memory depends on the number of workers, not on the size of the input: about 30 to 35 MB per worker plus about 130 MB for the main thread in our runs. Scrub with its residual check peaked at 325 MB on a 1 GB file with 6 workers, and at 397 MB and 405 MB on a 400 MB file and a 1.2 GB file with 8 workers: three times the data, the same memory. On a machine with many cores, lower `--workers` if memory is tight.

**Cores.** A single large file is split across all workers. A folder of many files is processed several files at a time as well. For `manifest` and `verify`, files are hashed in parallel, but one file is hashed on one core, because SHA-256 cannot be split. Mail parsing and zip unpacking run on the main thread.

**Speed.** [BENCH.md](BENCH.md) has the measured numbers and how to reproduce them with `npm run bench`. On a 2017 desktop CPU with 12 logical cores and a 1 GB file of support tickets: scrub 30.8 MB/s, the residual check 37.1 MB/s, secrets 294.4 MB/s, manifest 349.6 MB/s, verify 369.9 MB/s. Scrub and the residual check run one after the other by default, so the time for a checked scrub is the sum of the two.

Scrub is the slow one, and it is fair to say so. One worker scrubs about 6 to 7 MB/s of ticket data that is dense with personal data (5.9 replacements per 653-byte record). The detection engine makes about 25 pattern passes over each record plus dictionary lookups for names, each replacement has a cost, and each JSON record is parsed and written back. Profiling shows no single hot spot left to remove. Two changes were made to the engine for speed: the IPv6 and VIN passes are skipped when a cheap check shows they cannot match, and one scrubber is reused across records instead of being rebuilt. In an A/B run on this data the first change made the engine 15 to 18 percent faster with identical output. Replacing whole values by field name also saves work, since those values skip the pattern passes. Going well beyond this needs a single-pass engine, which would be a rewrite of the engine the website also uses, and has not been done.

Adding workers helps up to about the number of physical cores. On the benchmark machine (6 physical cores, 12 logical) 11 workers were between four and five times as fast as one.

## Limits

- Detection reduces personal data. It does not guarantee removal. A person should sample the output. The residual check uses the same kinds of rules as the scrub, so it cannot see what they cannot see.
- Labels are numbered per record. For the same label on the same value across records and files, use `--mode hash`.
- Names are not carried from one record to the next.
- A field name decides only when it is recognizable. A name stored under a key such as `col_7` or `x` gets the free-text detectors only. `plan` shows what was detected so you can set the action yourself.
- Field-name rules replace the whole value. A company name under `companyName`, or the word "N/A" under `ownerName`, is replaced too. Use a policy with `keep` or `text` where that is not wanted.
- A policy path applies to every file. When the same path means different things in different files (a top-level `name` in a clients file and in a templates file), `plan` says so in the reason column. Delete that entry from the policy so that each record is decided by its own surroundings, and do not use `--strict` for that run.
- In a multi-owner value such as `KOWALCZYK ZBIGNIEW & THANDIWE` the field itself gets one label, but the same people mentioned in free text may get labels of their own.
- Plain text is scrubbed one line at a time. Something that spans lines is not seen as a whole: a sign-off on its own line after "Best,", or a multi-line private key block. In JSON Lines, CSV and mail, line breaks inside a value are handled.
- A record longer than 4 MiB is not parsed. It is scrubbed as plain text in pieces of about 256 KB, cut at a space or tab where possible, with no field rules, and counted in the report as an oversized record. A value that sits across a cut can be missed. A CSV file with an unbalanced quote is treated this way from the bad quote until the next line end after the 4 MiB mark.
- A JSON line holding an integer too large for a JavaScript number, or a line that is not valid JSON, is scrubbed as plain text so the digits are not altered, with no field rules. These are counted as `jsonLinesScrubbedAsText`.
- A rewritten JSON line is compact JSON. Key order is kept, spacing is not, and `1.50` is written as `1.5`.
- Mail: a message larger than 32 MB is cut at 32 MB (what is lost is nearly always attachment data). Uncommon HTML entities in HTML-only mail are left as written. Messages are parsed on one core.
- `.json` documents over 64 MB are not supported. Convert them to JSON Lines.
- In a folder, files in other formats are skipped, not copied, and listed in the report.
- Input is read as UTF-8. Invalid bytes become U+FFFD. A UTF-8 byte order mark is dropped. Other encodings are not converted. Only `\n` and `\r\n` are line endings.
- Symbolic links: a link to a regular file inside the input folder is followed. A link to a folder, and any link that points outside the input folder, is skipped and reported. Zip entries with `..` or absolute paths are skipped.
- The output folder may not be the input folder or contain it. An output folder inside the input folder is allowed and is left out of the scan.
- Output is written to `<name>.partial` and renamed when complete. Ctrl-C removes unfinished files. If the process is killed outright, a `.partial` file can remain. It never has the final name.
- `plan` reads the first 4 MB of each file. Fields that first appear later are not in the policy; `--strict` catches them at scrub time.
- The file list of a folder, a manifest, and the per-field tables (capped at 5,000 field paths) are held in memory.
- `secrets` reports at most 500 findings per 256 KB block.
- Connectors are beta (see `pull`). They page through everything the token can read; there is no filtering beyond `--since`, `--query` and `--objects`.
- Tested on Windows with Node 24. The code uses only Node's standard library and should behave the same on Linux and macOS, but those have not been run yet.

## Check that it makes no network calls

1. The program is two files. List what the main one imports:

   ```
   grep -oE "from \"node:[a-z_/]+\"" dist/outrich.mjs | sort -u
   ```

   You will see `crypto`, `events`, `fs`, `os`, `path`, `stream`, `stream/promises`, `url`, `util`, `worker_threads` and `zlib`. There is no `http`, `https`, `net`, `dgram`, `dns` or `tls`, and no call to `fetch`. `dist/connectors.mjs` imports `fs` and `path` and contains the one `fetch` call in the project, directly after the check that the URL belongs to the configured host. The test suite fails if any of this changes (`tests/unit.test.mjs`, first two tests).
2. Delete `dist/connectors.mjs`. Every command except `pull` still works.
3. `package.json` has no `dependencies`. The `devDependencies` (esbuild, TypeScript, Node type definitions, and fflate, which one copied library file names in an import that the build removes as unused) are used to build and are not part of the program.
4. Run it with the network switched off: in a container started with `docker run --network none`, or on Linux under `strace -f -e trace=network`.

## Where the logic comes from, and how it differs from the website

The detection, manifest, mail parsing and conversion logic is the TypeScript the website runs. These files in `src/lib/` are copied from the `lib/` folder of the website repository (commit `9d95317`):

| File | Status |
|---|---|
| `manifest.ts`, `secrets.ts`, `profile.ts`, `datatools.ts`, `parsers.ts`, `pii-names.ts` | Unchanged copies. |
| `pii.ts` | Changed. Every change is marked `outrich-cli addition` or `outrich-cli change` in the source and listed below. |

Differences in `src/lib/pii.ts` from the website copy, so they can be ported back:

1. `reset()`, `replace(type, value)` and `learn(name)` on the scrubber: per-record reuse, whole-value replacement by field, and registering a name found in a name field.
2. Speed: the IPv6 and VIN pattern passes are skipped when a necessary-condition check fails. Output unchanged.
3. Email: a doubled dot in the domain (`user@domain..com`) is accepted.
4. US phones: `555 - 0146` as a separator, and a letter, `-word` or `(` may follow the number (`973.555.5201E`, `908 555 6000-office`, `908-555-3484(Mobile)`). A five-digit group after a two-letter state code is a ZIP code and no longer starts a phone number.
5. Names: a name in capitals is accepted next to a cue (`From: ZBIGNIEW KOWALCZYK`). A display name in front of `<address>` is taken as a name whether or not it is in the dictionary. Names learned from a display name, an email local part or a name field are also removed when one part appears alone, unless that part is a role word such as "support" or "billing".
6. Addresses: street words in capitals (`418 MAPLE ST`) and house-number ranges (`2204-18 HARBOR AVE`).
7. The cache key of a multi-word name is its sorted words, so "Lee Dana" and "Dana Lee" share a label. Hash tokens for multi-word names therefore differ from the website's.

`tests/upstream/` holds the untouched website copy of `pii.ts`. The tests run the website's own 72-test suite against the CLI copy (all pass) and compare the two engines on data the fixes do not touch. To sync: copy the website files over `src/lib/` and `tests/upstream/`, reapply the marked changes (or port them to the website so the files are identical again), and run `npm test`.

Not done from the request that led to items 3 to 6: remembering a linked name "for the rest of the file". Names are linked within a record only, for the reason given under "What is consistent".

## Development

```
npm install
npm test          # builds, then runs unit, end-to-end and connector tests (about 200 MB of generated data)
npm run bench     # generates 1 GB, runs the commands, rewrites BENCH.md with what it measured
npm run typecheck
```

`OUTRICH_E2E_MB=1024 npm test` runs the large-file test at 1 GB. `OUTRICH_TMP=/path` puts test and benchmark data on a disk of your choice. `OUTRICH_STATS=1` makes any command print its peak memory and wall time to stderr on exit. All test data is synthetic.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

MIT. Copyright (c) 2026 Outrich Data.

More tools, and what Outrich Data does: https://outrichdata.com/tools
