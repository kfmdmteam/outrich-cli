import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../dist/outrich.mjs", import.meta.url));

/** Runs the built CLI. Returns { status, stdout, stderr }. */
export function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A fresh temp folder, removed when the test ends. Set OUTRICH_TMP to put it on another disk. */
export function tmp(t) {
  const dir = fs.mkdtempSync(path.join(process.env.OUTRICH_TMP ?? os.tmpdir(), "outrich-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const write = (dir, rel, data) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
export const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
