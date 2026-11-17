# Benchmark

Measured by `npm run bench` on 2026-11-17. Every figure in the tables was measured on the machine below.
Run it on your own hardware before you plan around these numbers.

## Machine

| | |
|---|---|
| CPU | Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz |
| Logical cores | 12 |
| Memory | 15.8 GB |
| OS | Windows_NT 10.0.26200 (x64) |
| Node | v24.14.0 |
| outrich | 0.1.0 |

The machine was a desktop in normal use, with other programs running. No effort was made to quiet it.
Logical cores count hyper-threads, so the number of physical cores is lower.

## Data

Synthetic support tickets as JSON Lines, made by `scripts/gen.mjs`: 1,567,489 records in one file of 1024 MB
(653 bytes per record on average). Each ticket has a customer name, email and phone in their own fields,
an agent name, and a free-text body that sometimes repeats the email and phone and signs off with a first name.
The scrub run made 9,253,437 replacements, 5.9 per record. That is dense: text with less personal data in it scrubs faster.
The field-policy row uses a second synthetic set, property inspection records: 409,414 records, 256 MB, 625 bytes each,
with names, addresses and phones in their own fields. That run made 6,141,210 replacements, 15.0 per record.
All names, addresses and numbers are made up.

## Results

MB means 1,000,000 bytes. Time is wall time for the whole process, start to exit. Peak RSS is the peak resident memory of the process, all threads included.

| Command | Input | Time | Throughput | Peak RSS |
|---|---|---|---|---|
| scrub (11 workers) | 1024 MB | 33.3 s | 30.8 MB/s | 432 MB |
| scrub (1 worker) | 64 MB | 9.2 s | 6.9 MB/s | 147 MB |
| audit of the scrubbed tickets | 956 MB | 25.8 s | 37.1 MB/s | 400 MB |
| plan (reads 4 MB per file) | 256 MB | 0.7 s | 366.8 MB/s | 268 MB |
| scrub with a field policy (property records) | 256 MB | 10.6 s | 24.2 MB/s | 429 MB |
| manifest | 1024 MB | 2.9 s | 349.6 MB/s | 214 MB |
| verify | 1024 MB | 2.8 s | 369.9 MB/s | 214 MB |
| secrets (11 workers) | 1024 MB | 3.5 s | 294.4 MB/s | 378 MB |

The scrub rows ran with the residual check off (--no-audit) so that scrub and audit are timed separately. By default scrub runs the audit when it finishes, and the two times add up.
Plan reads only the first 4 MB of each file, so its time does not grow with file size and its throughput figure means little.
Scrub per worker: 6.9 MB/s with one worker, 2.8 MB/s per worker with 11 workers.
The secrets run reported 6,270 findings (the generator plants a fake key in one ticket out of 250).
Manifest and verify read a file that had just been written, so it was partly in the operating system's file cache. On cold data they are limited by the disk.
A single file is hashed on one core, because SHA-256 cannot be split. A folder of many files is hashed on all workers.

## Extrapolation (not measured)

At the rates measured above, 1 TB (1,000,000 MB) of data like this would take about 9.0 hours to scrub, 7.5 more hours for the residual check, 0.8 hours to manifest,
0.8 hours to verify and 0.9 hours to scan for secrets on this machine. This is arithmetic, not a measurement: nothing here was run at 1 TB,
and a real terabyte will not sit in the file cache.
