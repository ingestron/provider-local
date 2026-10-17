/** Installed core/CLI/MCP and independently locked local provider/files connector. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core"));
const { execute, executeAsync } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const require = createRequire(resolve(cliRoot, "package.json")),
  { parse, stringify } = require("yaml");
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
    .href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
    .href
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const base = required("OUTPUT");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(resolve(base, "local-schedules-"));
const put = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : stringify(value));
};
const cli = resolve(cliRoot, "build/cli/cli/index.js");
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
const sdk = (operation, args = {}) => executeAsync(context, operation, args);
const command = (operation, args = {}, permissions = true) => {
  const child = spawnSync(
    process.execPath,
    [
      cli,
      "--project",
      root,
      "--json",
      "--no-input",
      "operation",
      operation,
      ...(permissions ? ["--allow-write", "--allow-execute"] : []),
    ],
    {
      input: JSON.stringify(args),
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 2_000_000,
    },
  );
  assert.equal(child.error, undefined);
  return JSON.parse(child.stdout);
};
const provider = required("PROVIDER"),
  source = required("SOURCE");
const origins = [];
function origin(name, files, version) {
  const folder = resolve(root, "origins", name);
  mkdirSync(folder, { recursive: true });
  for (const [src, dest] of files)
    cpSync(src, resolve(folder, dest), { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, { cwd: folder, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "immutable local acceptance snapshot",
  );
  git("tag", version);
  origins.push({
    name,
    folder,
    version,
    commit: git("rev-parse", "HEAD").toString().trim(),
  });
  return folder;
}
const providerVersion = parse(
  readFileSync(resolve(provider, "plugin/provider.yaml"), "utf8"),
).version;
assert.equal(providerVersion, "0.4.10");
const sourceVersion = parse(
  readFileSync(resolve(source, "connectors/files/connector.yaml"), "utf8"),
).version;
const localOrigin = origin(
  "local",
  [
    [resolve(provider, "plugin"), "plugin"],
    [resolve(provider, "LICENSE"), "LICENSE"],
  ],
  providerVersion,
);
const filesOrigin = origin(
  "files",
  [
    [resolve(source, "connectors/files"), "connectors/files"],
    [resolve(source, "LICENSE"), "LICENSE"],
  ],
  sourceVersion,
);
const localRef = `synthetic/local/plugin/provider.yaml@${providerVersion}`,
  filesRef = `synthetic/source/connectors/files/connector.yaml@${sourceVersion}`;
passed(
  execute(context, "packages_install", {
    reference: localRef,
    fromGit: localOrigin,
  }),
);
passed(
  execute(context, "packages_install", {
    reference: filesRef,
    fromGit: filesOrigin,
  }),
);
const paths = {
  orders: resolve(root, "input/orders.csv"),
  customers: resolve(root, "input/customers.csv"),
};
put(paths.orders, "id,amount\n1,12.50\n2,23.00\n3,8.75\n");
put(paths.customers, "id,name\n1,Ada\n2,Noor\n3,Alex\n");
const contract = (name, fields) => ({
  apiVersion: "v3.1.0",
  kind: "DataContract",
  id: "file-" + name,
  name,
  version: "1.0.0",
  status: "draft",
  schema: [
    {
      name,
      logicalType: "object",
      physicalType: "table",
      properties: fields.map(([field, type, physical]) => ({
        name: field,
        logicalType: type,
        physicalType: physical,
        required: true,
      })),
    },
  ],
});
const start = new Date(Math.floor(Date.now() / 1000) * 1000)
  .toISOString()
  .replace(".000Z", "Z");
const schedule = {
  apiVersion: "ingestron.schedule/v1",
  enabled: true,
  timeZone: "UTC",
  start,
  recurrence: { kind: "interval", minutes: 1 },
  overlap: "queue",
  missed: "latest",
};
const project = {
  apiVersion: "ingestron.project/v1",
  id: "scheduled_retail",
  packages: { local: localRef, files: filesRef },
  providers: {
    configurations: { local: { package: "local", binding: "runtime" } },
  },
  defaults: { provider: "local" },
  environments: {
    dev: {
      apiVersion: "ingestron.environment/v1",
      environment: "dev",
      bindings: { runtime: { kind: "local" } },
    },
  },
  connections: {
    files: {
      package: "files",
      sourceId: "retail",
      tenantId: "synthetic",
      settings: {},
    },
  },
  flows: [
    {
      apiVersion: "ingestron.flow/v1",
      kind: "ingestion",
      id: "bronze",
      provider: "local",
      ingestion: { connection: "files", execution: { mode: "local" } },
      schedule,
      tables: {
        orders: {
          source: { path: paths.orders, format: "csv" },
          contract: contract("orders", [
            ["id", "integer", "BIGINT"],
            ["amount", "number", "DECIMAL(10,2)"],
          ]),
        },
        customers: {
          source: { path: paths.customers, format: "csv" },
          contract: contract("customers", [
            ["id", "integer", "BIGINT"],
            ["name", "string", "STRING"],
          ]),
        },
      },
    },
  ],
};
const checks = [];
let result = "failed",
  full;
function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(resolve(folder, entry.name))
      : [resolve(folder, entry.name)],
  );
}
try {
  const recurrences = [
    schedule.recurrence,
    { kind: "daily", times: ["09:15", "17:45"] },
    { kind: "weekly", weekDays: ["Monday", "Friday"], times: ["09:15"] },
    { kind: "monthly", monthDays: [1, 31], times: ["09:15"] },
  ];
  for (let index = 0; index < recurrences.length; index++) {
    project.flows[0].schedule = { ...schedule, recurrence: recurrences[index] };
    put(resolve(root, "project.yaml"), project);
    const from = `build/projections-${index}`;
    passed(execute(context, "build", { flow: "bronze", out: from }));
    const prepared = JSON.parse(
      readFileSync(resolve(root, from, "flows/bronze/connector.json"), "utf8"),
    );
    assert.deepEqual(
      prepared.projectLock.schedule.definition.recurrence,
      recurrences[index],
    );
    assert.equal(prepared.projectLock.schedule.clock, "portable");
  }
  checks.push(
    "four authored recurrences retain complete host envelopes through the real provider sandbox",
  );
  project.flows[0].schedule = schedule;
  put(resolve(root, "project.yaml"), project);
  const from = "build/scheduled";
  passed(execute(context, "build", { flow: "bronze", out: from }));
  console.log(
    "Built locked provider/files project; preparing exact Python runtime",
  );
  const prepared = passed(
    await sdk("runtime_prepare", { flow: "bronze", from }),
  );
  for (const action of ["discover", "review", "approve"])
    passed(await sdk("run", { flow: "bronze", from, action }));
  checks.push(
    "actual locked file connector runtime preparation, discovery, ODCS review and approval",
  );
  const inspection = passed(
    await sdk("scheduler_inspect", { flow: "bronze", from }),
  );
  assert.deepEqual(
    command("scheduler_inspect", { flow: "bronze", from }, false).result,
    JSON.parse(JSON.stringify(inspection)),
  );
  assert.equal(
    command(
      "scheduler_register",
      { flow: "bronze", from, expectedDigest: inspection.digest },
      false,
    ).ok,
    false,
  );
  const registered = passed(
    await sdk("scheduler_register", {
      flow: "bronze",
      from,
      expectedDigest: inspection.digest,
      graceSeconds: 3600,
    }),
  );
  checks.push(
    "installed SDK/CLI inspection parity and explicit registration permissions",
  );
  full = new Client({ name: "local-files-scheduler", version: "1.0.0" });
  await full.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "--project",
        root,
        "advanced",
        "mcp",
        "serve",
        "--allow-write",
        "--allow-execute",
      ],
      stderr: "pipe",
    }),
  );
  const call = async (op, args) =>
    JSON.parse(
      (await full.callTool({ name: "ingestron_" + op, arguments: args }))
        .content[0].text,
    );
  const original = readFileSync(paths.orders);
  put(paths.orders, "id,amount\nBAD,12.50\n2,23.00\n3,8.75\n");
  const due =
    Date.parse(start) +
    Math.ceil((Date.parse(registered.cursor) - Date.parse(start)) / 60000) *
      60000;
  assert.ok(due - Date.now() <= 60000);
  console.log(
    "Waiting for the first registered occurrence",
    new Date(due).toISOString(),
  );
  while (Date.now() < due + 1000)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, due + 1000 - Date.now())),
    );
  const failed = passed(
    await sdk("scheduler_tick", { flow: "bronze", limit: 1 }),
  );
  assert.equal(failed.outcomes.length, 1);
  assert.equal(failed.outcomes[0].status, "failed");
  const occurrence = failed.outcomes[0];
  assert.equal(
    walk(resolve(root, from)).filter((file) => file.endsWith("/commit.json"))
      .length,
    0,
  );
  checks.push(
    "malformed real CSV fails the scheduled occurrence and exposes no committed table output",
  );
  writeFileSync(paths.orders, original);
  const recovered = passed(
    await call("scheduler_retry", {
      flow: "bronze",
      occurrence: occurrence.occurrence,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(recovered.outcomes[0].runId, occurrence.runId);
  const commits = walk(resolve(root, from)).filter((file) =>
    file.endsWith("/commit.json"),
  );
  assert.equal(commits.length, 1);
  const receipt = JSON.parse(readFileSync(commits[0], "utf8"));
  assert.equal(receipt.identity.run_id, occurrence.runId);
  assert.deepEqual(
    receipt.tables.map((table) => ({ stream: table.stream, rows: table.rows })),
    [
      { stream: "customers", rows: 3 },
      { stream: "orders", rows: 3 },
    ],
  );
  const runtime = JSON.parse(
    readFileSync(resolve(root, from, "project-runtime.json"), "utf8"),
  );
  const key = prepared.result.flows[0].environment;
  const python = resolve(root, ".ingestron/runtimes", key, "bin/python");
  execFileSync(
    python,
    [
      "-I",
      "-c",
      "import sys,pyarrow.parquet as pq; from decimal import Decimal; from pathlib import Path; p=Path(sys.argv[1]); a=pq.read_table(p/'orders.parquet').to_pylist(); b=pq.read_table(p/'customers.parquet').to_pylist(); assert [r['id'] for r in a]==[1,2,3]; assert [r['amount'] for r in a]==[Decimal('12.50'),Decimal('23.00'),Decimal('8.75')]; assert [r['name'] for r in b]==['Ada','Noor','Alex']",
      dirname(commits[0]),
    ],
    { stdio: "pipe" },
  );
  checks.push(
    "MCP same-occurrence recovery commits both real Parquet tables with exact decimal values",
  );
  const bytes = Object.fromEntries(
    walk(dirname(commits[0])).map((file) => [file, sha(readFileSync(file))]),
  );
  assert.equal(
    passed(await sdk("scheduler_tick", { flow: "bronze", limit: 1 })).outcomes
      .length,
    0,
  );
  // A committed same-run replay must not reopen a source that has since failed.
  put(paths.orders, "id,amount\nBAD,12.50\n");
  const repeated = passed(
    await sdk("run", { retry: occurrence.runId, from, action: "run" }),
  );
  assert.equal(repeated.id, occurrence.runId);
  assert.deepEqual(
    Object.fromEntries(
      walk(dirname(commits[0])).map((file) => [file, sha(readFileSync(file))]),
    ),
    bytes,
  );
  writeFileSync(paths.orders, original);
  checks.push(
    "repeated tick and same-run replay preserve committed bytes despite subsequently malformed source input",
  );
  const paused = passed(
    await sdk("scheduler_pause", {
      flow: "bronze",
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(paused.enabled, false);
  const projectBytes = readFileSync(resolve(root, "project.yaml"));
  writeFileSync(
    resolve(root, "project.yaml"),
    Buffer.concat([projectBytes, Buffer.from("\n# stale changed input\n")]),
  );
  assert.equal(
    (await sdk("scheduler_tick", { flow: "bronze", limit: 1 })).ok,
    false,
  );
  writeFileSync(resolve(root, "project.yaml"), projectBytes);
  const status = passed(await sdk("scheduler_status", { flow: "bronze" }));
  assert.deepEqual(
    passed(await call("scheduler_status", { flow: "bronze" })),
    JSON.parse(JSON.stringify(status)),
  );
  checks.push(
    "paused status survives changed project inputs and remains identical through SDK/MCP",
  );
  result = "passed";
} finally {
  if (full) await full.close();
  const proof = {
    result,
    checkedAt: new Date().toISOString(),
    root,
    checks,
    origins,
    coreVersion: JSON.parse(readFileSync(resolve(coreRoot, "package.json")))
      .version,
    cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
      .version,
    providerVersion,
    filesVersion: sourceVersion,
    scope:
      "Actual immutable installed local-provider/files connector scheduled ingestion with synthetic CSV and real Parquet; no other source, child-process crash or native-platform qualification",
  };
  writeFileSync(required("PROOF"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify({ result, checks: checks.length, root }));
}
