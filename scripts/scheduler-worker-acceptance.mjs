/** Installed persistent worker against the actual locked local/file route. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
const required = (key) => {
  const value = process.env["INGESTRON_ACCEPTANCE_" + key];
  assert.ok(value, key);
  return resolve(value);
};
const fixture = JSON.parse(readFileSync(required("FIXTURE"), "utf8"));
assert.equal(fixture.result, "passed");
const output = required("OUTPUT");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(resolve(output, "source-worker-"));
cpSync(fixture.root, root, {
  recursive: true,
  filter: (path) =>
    !["build", "runs", "scheduler", "studio-jobs"].includes(
      path.split("/").at(-1),
    ),
});
const cliRoot = realpathSync(required("CLI_PACKAGE")),
  coreRoot = realpathSync(resolve(cliRoot, "../@ingestron/core")),
  require = createRequire(resolve(cliRoot, "package.json")),
  { parse, stringify } = require("yaml");
const { execute, executeAsync } = await import(
  pathToFileURL(resolve(coreRoot, "dist/sdk/index.js")).href
);
const { Client } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
      .href
  ),
  { StdioClientTransport } = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
      .href
  );
const readonly = new Client({ name: "worker-inspection", version: "1.0.0" }),
  full = new Client({ name: "worker-control", version: "1.0.0" });
const mcp = async (client, operation, args) =>
  JSON.parse(
    (await client.callTool({ name: "ingestron_" + operation, arguments: args }))
      .content[0].text,
  );
assert.equal(
  JSON.parse(readFileSync(resolve(coreRoot, "package.json"))).version,
  "0.12.28",
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
const call = (operation, args = {}) => executeAsync(context, operation, args);
const flowCall = (operation, args = {}) =>
  call(operation, { flow: "bronze", ...args });
const projectFile = resolve(root, "project.yaml"),
  project = parse(readFileSync(projectFile, "utf8"));
const second = structuredClone(project.flows[0]);
second.id = "bronze_other";
for (const [name, table] of Object.entries(project.flows[0].tables)) {
  table.source.path = table.source.path.replace(fixture.root, root);
  const content =
    name === "orders"
      ? "id,amount\n1,12.50\n2,2.75\n3,30.00\n"
      : readFileSync(table.source.path, "utf8");
  writeFileSync(table.source.path, content);
  second.tables[name].source.path = resolve(root, "other-data", name + ".csv");
  mkdirSync(dirname(second.tables[name].source.path), { recursive: true });
  writeFileSync(second.tables[name].source.path, content);
}
const start = new Date(Math.floor(Date.now() / 1000) * 1000)
  .toISOString()
  .replace(".000Z", "Z");
project.flows[0].schedule.start = start;
second.schedule.start = start;
project.flows.push(second);
writeFileSync(projectFile, stringify(project));
const from = "build/worker",
  cli = resolve(cliRoot, "build/cli/cli/index.js");
passed(execute(context, "build", { out: from }));
const prepared = passed(await call("runtime_prepare", { from }));
for (const action of ["discover", "review", "approve"])
  passed(await call("run", { from, action }));
const expectedDigests = {},
  registrations = {};
for (const flow of ["bronze", "bronze_other"]) {
  const inspected = passed(await call("scheduler_inspect", { flow, from }));
  expectedDigests[flow] = inspected.digest;
  registrations[flow] = passed(
    await call("scheduler_register", {
      flow,
      from,
      expectedDigest: inspected.digest,
      graceSeconds: 3600,
    }),
  );
}
function cliCall(operation, request, json = true) {
  return execFileSync(
    process.execPath,
    [
      cli,
      "--project",
      root,
      ...(json ? ["--json"] : []),
      "--no-input",
      "operation",
      operation,
      "--allow-write",
      "--allow-execute",
    ],
    {
      cwd: root,
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 20000,
    },
  );
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("Actual worker observation timed out");
}
const state = async (flow) =>
  passed(await call("scheduler_status", { flow })).state;
const workerStatus = async (id) =>
  passed(await call("scheduler_worker_status", { id })).workers[0];
function commits(folder) {
  return existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory()
          ? commits(resolve(folder, item.name))
          : item.name === "commit.json"
            ? [resolve(folder, item.name)]
            : [],
      )
    : [];
}
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
let workerId,
  result = "failed";
const checks = [];
try {
  for (const permission of [{ allowWrite: false }, { allowExecute: false }]) {
    const denied = await executeAsync(
      { ...context, ...permission },
      "scheduler_worker_start",
      { flows: Object.keys(expectedDigests), expectedDigests },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.diagnostics[0].code, "PERMISSION");
  }
  const started = passed(
    JSON.parse(
      cliCall("scheduler_worker_start", {
        flows: Object.keys(expectedDigests),
        expectedDigests,
        pollSeconds: 1,
        limit: 1,
      }),
    ),
  );
  workerId = started.worker.id;
  await readonly.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--project", root, "advanced", "mcp", "serve"],
      stderr: "pipe",
    }),
  );
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
  const ro = (await readonly.listTools()).tools.map((v) => v.name),
    rw = (await full.listTools()).tools.map((v) => v.name);
  for (const operation of ["scheduler_worker_start", "scheduler_worker_stop"]) {
    assert.equal(ro.includes("ingestron_" + operation), false);
    assert.equal(rw.includes("ingestron_" + operation), true);
  }
  assert.equal(ro.includes("ingestron_scheduler_worker_status"), true);
  assert.equal(
    passed(await mcp(readonly, "scheduler_worker_status", { id: workerId }))
      .workers[0].id,
    workerId,
  );
  checks.push(
    "actual installed MCP exposes inspection read-only and requires both permissions for persistent start/stop",
  );
  assert.equal(started.worker.status, "running");
  assert.equal(started.worker.alive, true);
  const current = await workerStatus(workerId);
  assert.equal(current.alive, true);
  assert.deepEqual(
    passed(JSON.parse(cliCall("scheduler_worker_status", { id: workerId })))
      .workers[0].flows,
    current.flows,
  );
  assert.doesNotMatch(
    JSON.stringify(started),
    /"token"|"port"|"digest"|"envFile"/,
  );
  const duplicate = await call("scheduler_worker_start", {
    flows: ["bronze"],
    expectedDigests: { bronze: expectedDigests.bronze },
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.diagnostics[0].code, "SCHEDULE_DRIVER");
  checks.push(
    "installed CLI exits while real core driver persists; both permissions and exclusive flow claims are enforced",
  );
  // Test the actual worker receiver with a wrong nonce, rather than faking a stop service.
  const db = new DatabaseSync(
    resolve(root, ".ingestron/scheduler/state.sqlite"),
    { readOnly: true },
  );
  const privateRecord = JSON.parse(
    db.prepare("SELECT value FROM workers WHERE id=?").get(workerId).value,
  );
  db.close();
  await new Promise((done) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: privateRecord.port,
    });
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", done);
    socket.on("connect", () =>
      socket.end(
        JSON.stringify({ id: workerId, token: randomUUID(), interrupt: true }) +
          "\n",
      ),
    );
  });
  assert.equal((await workerStatus(workerId)).stopRequested, false);
  checks.push(
    "actual loopback stop control rejects a foreign nonce and publishes no private control identity",
  );
  await until(
    async () =>
      (await state("bronze")).work.some((v) => v.status === "succeeded") &&
      (await state("bronze_other")).work.some((v) => v.status === "succeeded"),
  );
  const first = (await state("bronze")).work.find(
    (v) => v.status === "succeeded",
  );
  const originalCommit = commits(resolve(root, from, "data/bronze"))[0];
  assert.ok(originalCommit);
  const commit = JSON.parse(readFileSync(originalCommit, "utf8"));
  assert.equal(commit.identity.run_id, first.runId);
  assert.deepEqual(
    commit.tables.map((v) => ({ stream: v.stream, rows: v.rows })),
    [
      { stream: "customers", rows: 3 },
      { stream: "orders", rows: 3 },
    ],
  );
  const python = resolve(
    root,
    ".ingestron/runtimes",
    prepared.result.flows[0].environment,
    "bin/python",
  );
  execFileSync(
    python,
    [
      "-I",
      "-c",
      "import sys,pyarrow.parquet as pq;from pathlib import Path;from decimal import Decimal;p=Path(sys.argv[1]);a=pq.read_table(p/'orders.parquet').to_pylist();b=pq.read_table(p/'customers.parquet').to_pylist();assert [r['id'] for r in a]==[1,2,3];assert [r['amount'] for r in a]==[Decimal('12.50'),Decimal('2.75'),Decimal('30.00')];assert [r['name'] for r in b]==['Ada','Noor','Alex']",
      dirname(originalCommit),
    ],
    { stdio: "pipe" },
  );
  const originalBytes = sha(originalCommit);
  const secondDue = Date.parse(first.at) + 60000;
  writeFileSync(
    project.flows[0].tables.orders.source.path,
    "id,amount\nBAD,not-a-decimal\n",
  );
  const failed = await until(
    async () =>
      (await state("bronze")).work.find(
        (v) => v.status === "failed" && v.id !== first.id,
      ),
    Math.max(90000, secondDue - Date.now() + 30000),
  );
  await until(
    async () =>
      (await state("bronze_other")).work.filter((v) => v.status === "succeeded")
        .length >= 2,
  );
  await sleep(2500);
  assert.equal(
    (await state("bronze")).work.find((v) => v.id === failed.id).attempt,
    1,
  );
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 1);
  assert.equal(sha(originalCommit), originalBytes);
  assert.equal(
    (await workerStatus(workerId)).health.find((v) => v.flow === "bronze")
      .status,
    "attention",
  );
  checks.push(
    "real two-flow repeated source ingestion commits once per occurrence; malformed CSV retains failure without automatic retry while the other flow continues",
  );
  writeFileSync(
    project.flows[0].tables.orders.source.path,
    "id,amount\n1,12.50\n2,2.75\n3,30.00\n",
  );
  const retry = passed(
    await flowCall("scheduler_retry", {
      occurrence: failed.id,
      expectedDigest: expectedDigests.bronze,
    }),
  );
  assert.equal(retry.outcomes[0].runId, failed.runId);
  assert.equal(retry.outcomes[0].status, "succeeded");
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 2);
  assert.equal(sha(originalCommit), originalBytes);
  for (const flow of Object.keys(expectedDigests))
    passed(
      await call("scheduler_pause", {
        flow,
        expectedDigest: expectedDigests[flow],
      }),
    );
  await until(async () =>
    (await workerStatus(workerId)).health.every((v) => v.status === "paused"),
  );
  checks.push(
    "explicit same-occurrence recovery returns real source output; paused registrations remain visible to the driver",
  );
  const stop = passed(
    await call("scheduler_worker_stop", { id: workerId, interrupt: false }),
  );
  assert.equal(stop.controlAccepted, true);
  const stopped = await until(async () => {
    const v = await workerStatus(workerId);
    return v.status === "stopped" && !v.alive ? v : undefined;
  });
  assert.equal(stopped.stopRequested, true);
  const previousWorker = workerId;
  workerId = undefined;
  const restarted = passed(
    await call("scheduler_worker_start", {
      flows: Object.keys(expectedDigests),
      expectedDigests,
      pollSeconds: 1,
    }),
  );
  workerId = restarted.worker.id;
  assert.notEqual(workerId, previousWorker);
  const historicalStop = passed(
    await call("scheduler_worker_stop", { id: previousWorker }),
  );
  assert.equal(historicalStop.worker.status, "stopped");
  assert.equal((await workerStatus(workerId)).stopRequested, false);
  // Interrupt an actual source child through the worker's own authenticated receiver.
  writeFileSync(
    project.flows[0].tables.orders.source.path,
    "id,amount\n" +
      Array.from({ length: 200000 }, (_, i) => `${i + 1},12.50\n`).join(""),
  );
  passed(
    await flowCall("scheduler_register", {
      from,
      expectedDigest: expectedDigests.bronze,
    }),
  );
  const daemonPid = (await workerStatus(workerId)).pid;
  const active = await until(async () => {
    const work = (await state("bronze")).work.find(
      (v) => v.status === "running",
    );
    if (!work) return;
    const processes = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match && match[3].includes(root)
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                command: match[3],
              },
            ]
          : [];
      });
    const provider = processes.find(
      (v) => v.ppid === daemonPid && v.command.includes("/execute.py"),
    );
    return provider &&
      processes.some(
        (v) =>
          v.ppid === provider.pid &&
          v.command.includes("/singer_runtime.py run "),
      )
      ? work
      : undefined;
  });
  const interruptedStop = passed(
    await call("scheduler_worker_stop", { id: workerId, interrupt: true }),
  );
  assert.equal(interruptedStop.controlAccepted, true);
  await until(async () => {
    const w = await workerStatus(workerId);
    return w.status === "stopped" && !w.alive;
  });
  const interrupted = (await state("bronze")).work.find(
    (v) => v.id === active.id,
  );
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.runId, active.runId);
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 2);
  workerId = undefined;
  const recovered = passed(
    await flowCall("scheduler_retry", {
      occurrence: active.id,
      expectedDigest: expectedDigests.bronze,
    }),
  );
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(recovered.outcomes[0].runId, active.runId);
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 3);
  passed(
    await flowCall("scheduler_pause", {
      expectedDigest: expectedDigests.bronze,
    }),
  );
  checks.push(
    "authenticated interrupt stops an actual 200000-row source child, retains the interrupted claim, and explicit same-ID recovery commits once",
  );
  const finalWorker = passed(
    await call("scheduler_worker_start", {
      flows: Object.keys(expectedDigests),
      expectedDigests,
      pollSeconds: 1,
    }),
  );
  workerId = finalWorker.worker.id;
  // Saved paths stop being executable after review changes, but worker state is still inspectable/stoppable.
  project.name = "Changed after review";
  writeFileSync(projectFile, stringify(project));
  const stale = await flowCall("scheduler_register", {
    from,
    expectedDigest: expectedDigests.bronze,
  });
  assert.equal(stale.ok, false);
  assert.equal((await workerStatus(workerId)).alive, true);
  passed(
    await mcp(full, "scheduler_worker_stop", { id: workerId, interrupt: true }),
  );
  await until(async () => (await workerStatus(workerId)).status === "stopped");
  workerId = undefined;
  checks.push(
    "authenticated drain/stop closes the actual daemon, restart uses a new identity, old stop cannot affect it, and broken inputs do not hide lifecycle control",
  );
  result = "passed";
} finally {
  if (workerId) {
    await call("scheduler_worker_stop", { id: workerId, interrupt: true });
    await until(async () => !(await workerStatus(workerId)).alive, 15000);
  }
  await readonly.close();
  await full.close();
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        checkedAt: new Date().toISOString(),
        root,
        checks,
        coreVersion: "0.12.28",
        cliVersion: "0.17.12",
        fixture: required("FIXTURE"),
        scope:
          "Actual immutable installed core/CLI persistent worker and local0.4.10/files1.5.8 synthetic CSV ingestion; no native/cloud/source network activation or Studio worker UI qualification",
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ result, checks: checks.length, root }));
