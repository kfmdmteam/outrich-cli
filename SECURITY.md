# Security policy

## What this tool does with your data

`outrich` reads the files you point it at and writes the files you ask for. It sends no telemetry and
checks for no updates. It has no runtime dependencies: the published program is two files built
from the source in this repository.

Every command except `pull` works with no network access. The main program, `dist/outrich.mjs`,
contains no network code. `pull` (and `run` when its config names a system to pull from) loads
`dist/connectors.mjs`, which contacts one host: the API of the system you named, or the
`--base-url` you gave. API tokens are read from environment variables, sent in a request header,
and never printed, put in a URL or written to disk. The README explains how to check all of this.

Audit reports and secret findings never contain the values that were found. Reports hold counts.
Secret findings hold a masked preview (the first four and last two characters at most).
A salt passed with `--salt` is not written to any report or state file.

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Use "Report a vulnerability" on the Security tab of the GitHub repository, or
- email hello@outrichdata.com.

Include the version (`outrich --version`), your Node version and operating system, and the
smallest input that shows the problem. Do not send real personal data or live credentials;
a made-up example that triggers the same behavior is enough.

A missed detection (personal data or a secret the tool did not catch) is a quality problem,
not a vulnerability, unless it comes from a defect that makes the tool skip input silently.
Reports of missed detections are still welcome as ordinary issues, with synthetic examples.

## Supported versions

Fixes are made on the latest release only.
