/** Install the exact published CLI/core baseline in an isolated local prefix. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const baseline = JSON.parse(
  readFileSync(new URL("./cli-baseline.json", import.meta.url)),
);
const host = resolve(".cli-host");
mkdirSync(host, { recursive: true });
writeFileSync(
  resolve(host, "package.json"),
  JSON.stringify({ private: true }) + "\n",
);
execFileSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    `ingestron@${baseline.cli}`,
  ],
  { cwd: host, stdio: "inherit" },
);
const cli = JSON.parse(
  readFileSync(resolve(host, "node_modules/ingestron/package.json")),
);
const core = JSON.parse(
  readFileSync(resolve(host, "node_modules/@ingestron/core/package.json")),
);
assert.equal(cli.version, baseline.cli);
assert.equal(cli.dependencies["@ingestron/core"], baseline.core);
assert.equal(core.version, baseline.core);
writeFileSync(
  resolve(host, "source.json"),
  JSON.stringify({ source: "npm registry", ...baseline }, null, 2) + "\n",
);
console.log(`Installed CLI ${cli.version} / core ${core.version}`);
