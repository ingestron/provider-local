/** Install the exact published GitHub CLI source with its registry core dependency. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const commit = "798444c5ebd969d9846fc6912afdf72bb298d876";
const temp = mkdtempSync(resolve(tmpdir(), "ingestron-cli-"));
const host = resolve(".cli-host");
const run = (cmd, args, cwd = temp) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
try {
  run("git", [
    "clone",
    "--quiet",
    "https://github.com/ingestron/cli.git",
    "source",
  ]);
  const source = resolve(temp, "source");
  run("git", ["checkout", "--quiet", commit], source);
  run("pnpm", ["install", "--frozen-lockfile"], source);
  run("pnpm", ["build"], source);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", temp], source);
  mkdirSync(host, { recursive: true });
  writeFileSync(
    resolve(host, "package.json"),
    JSON.stringify({ private: true }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      resolve(temp, "ingestron-0.12.0.tgz"),
    ],
    host,
  );
  writeFileSync(
    resolve(host, "source.json"),
    JSON.stringify(
      {
        repository: "https://github.com/ingestron/cli",
        commit,
        cli: "0.12.0",
        core: "0.12.0",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
