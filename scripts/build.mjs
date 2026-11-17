// Bundles the CLI to one file with no runtime dependencies. Also builds the pristine website copy of the
// scrub engine (tests/upstream/pii.ts) so the tests can prove the CLI's tuned copy gives the same output.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const common = { bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning" };
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/outrich.mjs", banner: { js: "#!/usr/bin/env node" }, define: { __VERSION__: JSON.stringify(version) } });
// The connectors are the only network code. They are a separate file, loaded on demand by `pull`.
await build({ ...common, entryPoints: ["src/connectors/index.ts"], outfile: "dist/connectors.mjs" });
// Test-only bundles: the website's untouched engine, and the CLI's copy of it with its full export list.
await build({ ...common, entryPoints: ["tests/upstream/pii.ts"], outfile: "tests/.build/upstream-pii.mjs" });
await build({ ...common, entryPoints: ["src/lib/pii.ts", "src/lib/pii-names.ts"], outdir: "tests/.build/cli", outExtension: { ".js": ".mjs" } });
