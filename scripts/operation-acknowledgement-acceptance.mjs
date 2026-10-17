/** Installed setup actions, actual adapter death, original finalisation and SDK/CLI/MCP recovery. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const fixture = JSON.parse(readFileSync(required("FIXTURE"), "utf8"));
assert.equal(fixture.result, "passed");
mkdirSync(required("OUTPUT"), { recursive: true });
const root = mkdtempSync(resolve(required("OUTPUT"), "setup-recovery-"));
cpSync(fixture.root, root, {
  recursive: true,
  filter: (path) =>
    !["build", "runs", "scheduler", "studio-jobs"].includes(
      path.split("/").at(-1),
    ),
});
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core"));
const require = createRequire(resolve(cliRoot, "package.json")),
  { parse, stringify } = require("yaml");
const { execute, executeAsync } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const passed = (value) => {
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
};
const context = {
  root,
  environment: "dev",
  allowWrite: true,
  allowExecute: true,
  allowNetwork: true,
};
const acknowledge = { ...context, allowNetwork: false },
  readonly = {
    ...context,
    allowWrite: false,
    allowExecute: false,
    allowNetwork: false,
  };
const projectFile = resolve(root, "project.yaml"),
  project = parse(readFileSync(projectFile, "utf8"));
for (const table of Object.values(project.flows[0].tables))
  table.source.path = table.source.path.replace(fixture.root, root);
const reference = "synthetic/local/plugin/provider.yaml@0.4.12";
project.packages.local = reference;
writeFileSync(projectFile, stringify(project));
passed(
  execute(context, "packages_install", {
    reference,
    fromGit: required("PROVIDER_ORIGIN"),
  }),
);
// Qualify fresh preparation; a cached lookup can finish before an OS process barrier.
const runtimes = resolve(root, ".ingestron/runtimes");
if (existsSync(runtimes))
  renameSync(
    runtimes,
    resolve(root, ".ingestron/runtimes-before-acknowledgement"),
  );
const from = "build/acknowledgement";
passed(execute(context, "build", { flow: "bronze", out: from }));
const cli = resolve(cliRoot, "build/cli/cli/index.js");
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const manifest = resolve(root, from, "ingestron-manifest.json"),
  manifestBefore = sha(manifest);
const checks = [],
  owned = [];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await wait(5);
  }
  throw Error("Owned original operation did not reach its process barrier");
}
function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return m && m[4].includes(root)
        ? [
            {
              pid: Number(m[1]),
              parent: Number(m[2]),
              status: m[3],
              command: m[4],
            },
          ]
        : [];
    });
}
function identity(row) {
  return {
    ...row,
    birth: execFileSync("ps", ["-p", String(row.pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim(),
  };
}
function signal(row, value) {
  const current = processes().find((p) => p.pid === row.pid);
  if (!current) return;
  assert.equal(current.command, row.command);
  assert.equal(
    execFileSync("ps", ["-p", String(row.pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim(),
    row.birth,
  );
  process.kill(row.pid, value);
}
let result = "failed";
try {
  const discoveryFile = resolve(root, from, "flows/bronze/discovery.json");
  let originalDiscovery;
  for (const { action, expected } of [
    ...["prepare", "catalogue", "discover", "review", "approve"].map(
      (action) => ({ action, expected: "succeeded" }),
    ),
    { action: "review", expected: "failed" },
  ]) {
    if (expected === "failed") {
      originalDiscovery = readFileSync(discoveryFile);
      writeFileSync(discoveryFile, "{invalid reviewed metadata");
    }
    const operation = action === "prepare" ? "runtime_prepare" : "run";
    const initial = executeAsync(context, operation, {
      from,
      flow: "bronze",
      ...(action === "prepare" ? {} : { action }),
    });
    const parent = identity(
      await until(() =>
        processes().find(
          (p) => p.parent === process.pid && /execute\.py$/.test(p.command),
        ),
      ),
    );
    owned.push(parent);
    const worker = identity(
      await until(() =>
        processes().find(
          (p) =>
            p.parent === parent.pid &&
            p.command.endsWith("execute.py --operation-worker"),
        ),
      ),
    );
    owned.push(worker);
    signal(worker, "SIGSTOP");
    const run = await until(() =>
      readdirSync(resolve(root, ".ingestron/runs"))
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          JSON.parse(
            readFileSync(resolve(root, ".ingestron/runs", name), "utf8"),
          ),
        )
        .find((value) => value.action === action && value.status === "running"),
    );
    const ackFile = resolve(
      root,
      ".ingestron/runtimes/.ingestron-operation-receipts",
      run.fingerprint,
      run.id,
      "acknowledgement.json",
    );
    assert.equal(
      existsSync(ackFile),
      false,
      "Finaliser must be stopped before it acknowledged original work",
    );
    signal(parent, "SIGKILL");
    const unknown = await initial;
    assert.equal(unknown.ok, false);
    const receipt = passed(
      await executeAsync(readonly, "run_status", { id: run.id }),
    );
    assert.equal(receipt.status, "indeterminate");
    assert.equal(receipt.recoveryRequired, true);
    const refused = await executeAsync(readonly, "execution_recover", {
      id: run.id,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.diagnostics[0].code, "PERMISSION");
    const wrongEnvironment = await executeAsync(
      { ...acknowledge, environment: "test" },
      "execution_recover",
      { id: run.id },
    );
    assert.equal(wrongEnvironment.ok, false);
    const pending = await executeAsync(acknowledge, "execution_recover", {
      id: run.id,
    });
    assert.equal(pending.ok, false);
    assert.equal(
      passed(await executeAsync(readonly, "run_status", { id: run.id }))
        .recoveryRequired,
      true,
    );
    const blocked = execute(context, "build", { flow: "bronze", out: from });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.diagnostics[0].code, "EXECUTION_ACTIVE");
    assert.equal(sha(manifest), manifestBefore);
    const human = spawnSync(
      process.execPath,
      [
        cli,
        "--project",
        root,
        "--environment",
        "dev",
        "--plain",
        "--no-input",
        "run",
        "status",
        run.id,
      ],
      { encoding: "utf8" },
    );
    assert.equal(human.status, 0);
    assert.ok(human.stdout.includes("run recover " + run.id));
    assert.ok(!human.stdout.includes("--retry"));
    signal(worker, "SIGCONT");
    await until(() => existsSync(ackFile), 600000);
    const originalAck = sha(ackFile);
    const evidence = ["catalogue.json", "discovery.json", "review.json"]
      .map((name) => resolve(root, from, "flows/bronze", name))
      .filter(existsSync)
      .map((path) => ({ path, sha256: sha(path) }));
    const recovered = passed(
      await executeAsync(acknowledge, "execution_recover", { id: run.id }),
    );
    assert.equal(recovered.id, run.id);
    assert.equal(recovered.action, action);
    assert.equal(recovered.status, expected);
    assert.equal(recovered.recoveryRequired, false);
    assert.equal(recovered.acknowledgedOriginalOperation, true);
    const normal = spawnSync(
      process.execPath,
      [
        cli,
        "--project",
        root,
        "--environment",
        "dev",
        "--json",
        "--no-input",
        "run",
        "recover",
        run.id,
      ],
      { encoding: "utf8" },
    );
    assert.equal(normal.status, expected === "failed" ? 2 : 0, normal.stderr);
    const cliResult = JSON.parse(normal.stdout);
    assert.equal(cliResult.ok, true);
    assert.equal(cliResult.result.id, run.id);
    assert.equal(cliResult.result.acknowledgedOriginalOperation, true);
    assert.equal(
      sha(ackFile),
      originalAck,
      "Recovery reads the exact original acknowledgement without rewriting it",
    );
    assert.equal(sha(manifest), manifestBefore);
    for (const entry of evidence) assert.equal(sha(entry.path), entry.sha256);
    if (expected === "failed") writeFileSync(discoveryFile, originalDiscovery);
    checks.push({
      action,
      expectedOriginalStatus: expected,
      committedMetadataUnchangedDuringRecovery: true,
      id: run.id,
      unknownRetained: true,
      pendingRecoveryKeptBuild: true,
      readonlyAndForeignScopeDenied: true,
      sdkAndNormalCliOriginalAcknowledgement: true,
      originalAcknowledgementSha256: originalAck,
    });
  }
  const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
      .href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
      .href
  );
  for (const flags of [
    [],
    ["--allow-write"],
    ["--allow-execute"],
    ["--allow-write", "--allow-execute"],
  ]) {
    const client = new Client({
      name: "synthetic-acknowledgement",
      version: "1",
    });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "--project", root, "advanced", "mcp", "serve", ...flags],
          stderr: "pipe",
        }),
      );
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === "ingestron_execution_recover",
      );
      assert.equal(!!tool, flags.length === 2);
      if (tool) {
        assert.equal(tool.annotations.readOnlyHint, false);
        const ack = await client.callTool({
          name: tool.name,
          arguments: { id: checks.at(-1).id },
        });
        assert.equal(ack.isError, false);
      }
    } finally {
      await client.close();
    }
  }
  passed(execute(context, "build", { flow: "bronze", out: from }));
  result = "passed";
} finally {
  for (const process of owned.reverse()) {
    try {
      signal(process, "SIGCONT");
      signal(process, "SIGTERM");
    } catch {}
  }
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        checkedAt: new Date().toISOString(),
        root,
        checks,
        coreVersion: "0.12.34",
        cliVersion: "0.17.16",
        providerVersion: "0.4.12",
        scope:
          "Actual immutable installed local provider setup finaliser and original adapter termination across prepare/catalogue/discover/review/approve, retained pending recovery, SDK/normalCLI acknowledgement without network or replay, MCP dual opt-in. Worker stopped before acknowledgement; not all source-process write/crash variants, reviewed abandonment, Studio/browser or native qualification.",
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ result, actions: checks.length }));
