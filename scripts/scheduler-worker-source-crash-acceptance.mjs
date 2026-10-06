/** Actual detached daemon death with an active installed local/file source child. */
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
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
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
const output = required("OUTPUT");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(resolve(output, "worker-source-crash-"));
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
const call = (operation, args = {}) =>
  executeAsync(context, operation, { flow: "bronze", ...args });
const projectFile = resolve(root, "project.yaml"),
  project = parse(readFileSync(projectFile, "utf8"));
for (const table of Object.values(project.flows[0].tables))
  table.source.path = table.source.path.replace(fixture.root, root);
const orders = project.flows[0].tables.orders.source.path;
writeFileSync(
  orders,
  "id,amount\n" +
    Array.from({ length: 200000 }, (_, index) => `${index + 1},12.50\n`).join(
      "",
    ),
);
const start = new Date(Math.floor(Date.now() / 1000) * 1000)
  .toISOString()
  .replace(".000Z", "Z");
project.flows[0].schedule.start = start;
writeFileSync(projectFile, stringify(project));
const from = "build/scheduled",
  flowFolder = resolve(root, from, "flows/bronze");
passed(execute(context, "build", { flow: "bronze", out: from }));
passed(await call("runtime_prepare", { from }));
for (const action of ["discover", "review", "approve"])
  passed(await call("run", { from, action }));
const inspected = passed(await call("scheduler_inspect", { from })),
  registered = passed(
    await call("scheduler_register", {
      from,
      expectedDigest: inspected.digest,
      graceSeconds: 3600,
    }),
  );
const due =
  Date.parse(start) +
  Math.ceil((Date.parse(registered.cursor) - Date.parse(start)) / 60000) *
    60000;
console.log(
  "Prepared actual 200000-row file route; waiting for due occurrence",
  new Date(due).toISOString(),
);
while (Date.now() < due + 1000)
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(1000, due + 1000 - Date.now())),
  );
function processes() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return match && match[4].includes(root)
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              status: match[3],
              command: match[4],
            },
          ]
        : [];
    });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(30);
  }
  throw new Error("Owned-process observation timed out");
}
function locked() {
  return (
    execFileSync(
      "python3.12",
      [
        "-I",
        "-c",
        "import fcntl,sys; f=open(sys.argv[1],'a');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('0')\nexcept BlockingIOError: print('1')",
        resolve(flowFolder, ".execution.lock"),
      ],
      { encoding: "utf8" },
    ).trim() === "1"
  );
}
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
function identity(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}
const workerStatus = async (id) =>
  passed(await executeAsync(context, "scheduler_worker_status", { id }))
    .workers[0];
const startWorker = () =>
  executeAsync(context, "scheduler_worker_start", {
    flows: ["bronze"],
    expectedDigests: { bronze: inspected.digest },
    pollSeconds: 1,
    limit: 1,
  });
let daemon,
  daemonIdentity,
  replacement,
  provider,
  source,
  result = "failed";
const checks = [];
try {
  daemon = passed(await startWorker()).worker;
  assert.equal(daemon.alive, true);
  daemonIdentity = identity(daemon.pid);
  assert.ok(
    daemonIdentity?.includes(
      resolve(coreRoot, "dist/core/scheduler-worker-main.js"),
    ),
  );
  ({ provider, source } = await until(() => {
    const list = processes();
    const p = list.find(
      (item) =>
        item.ppid === daemon.pid && item.command.includes("/execute.py"),
    );
    const s =
      p &&
      list.find(
        (item) =>
          item.ppid === p.pid &&
          item.command.includes("/singer_runtime.py run "),
      );
    return s && locked()
      ? {
          provider: { ...p, identity: identity(p.pid) },
          source: { ...s, identity: identity(s.pid) },
        }
      : undefined;
  }));
  assert.equal(identity(provider.pid), provider.identity);
  process.kill(provider.pid, "SIGSTOP");
  await until(() =>
    processes().find((p) => p.pid === provider.pid && p.status.startsWith("T")),
  );
  const active = passed(await call("scheduler_status")).state.work.find(
    (w) => w.status === "running",
  );
  assert.ok(active);
  assert.equal(active.workerPid, daemon.pid);
  const denied = await call("scheduler_retry", {
    occurrence: active.id,
    expectedDigest: registered.bindingDigest,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].code, "SCHEDULE_ACTIVE");
  passed(
    await call("scheduler_pause", { expectedDigest: registered.bindingDigest }),
  );
  checks.push(
    "actual detached daemon owns the running business claim while its live provider holds the execution lock; live retry is refused",
  );

  // Only the exact daemon created by this harness is signalled; product stop never kills stored PIDs.
  assert.equal(identity(daemon.pid), daemonIdentity);
  process.kill(daemon.pid, "SIGKILL");
  await until(async () => (await workerStatus(daemon.id)).recoveryRequired);
  assert.equal(
    passed(await call("scheduler_status")).state.work.find(
      (w) => w.id === active.id,
    ).status,
    "running",
  );
  const reserved = await startWorker();
  assert.equal(reserved.ok, false);
  assert.equal(reserved.diagnostics[0].code, "SCHEDULE_DRIVER");
  const released = passed(
    await executeAsync(context, "scheduler_worker_stop", {
      id: daemon.id,
      interrupt: true,
    }),
  );
  assert.equal(released.worker.status, "failed");
  assert.equal(released.worker.errorCode, "SCHEDULE_WORKER_LOST");
  assert.equal(released.worker.alive, false);
  assert.equal(released.controlAccepted, false);
  assert.equal(
    passed(await call("scheduler_status")).state.work.find(
      (w) => w.id === active.id,
    ).status,
    "running",
  );
  assert.equal(locked(), true);
  assert.equal(identity(provider.pid), provider.identity);
  checks.push(
    "actual active-source daemon death retains both driver reservation and uncertain business claim; explicit lost-driver stop releases only the driver and leaves the original provider alive",
  );

  replacement = passed(await startWorker()).worker;
  assert.notEqual(replacement.id, daemon.id);
  await until(async () =>
    (await workerStatus(replacement.id)).health.every(
      (h) => h.status === "paused",
    ),
  );
  passed(
    await executeAsync(context, "scheduler_worker_stop", {
      id: daemon.id,
      interrupt: true,
    }),
  );
  assert.equal((await workerStatus(replacement.id)).alive, true);
  const refused = passed(
    await call("scheduler_retry", {
      occurrence: active.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(refused.outcomes[0].status, "failed");
  assert.equal(refused.outcomes[0].runId, active.runId);
  assert.equal(locked(), true);
  const retained = passed(await call("scheduler_status")).state.work.find(
    (w) => w.id === active.id,
  );
  assert.equal(retained.attempt, 2);
  await sleep(2200);
  assert.equal(
    passed(await call("scheduler_status")).state.work.find(
      (w) => w.id === active.id,
    ).attempt,
    2,
  );
  checks.push(
    "a replacement paused driver has a new identity and survives stop of the old ID; explicit same-run recovery cannot execute through the residual provider lock",
  );

  const committed = await until(
    () => commits(resolve(root, from, "data/bronze"))[0],
    120000,
  );
  const receipt = JSON.parse(readFileSync(committed, "utf8"));
  assert.equal(receipt.identity.run_id, active.runId);
  assert.equal(receipt.tables.find((t) => t.stream === "orders").rows, 200000);
  assert.equal(receipt.tables.find((t) => t.stream === "customers").rows, 3);
  assert.equal(identity(provider.pid), provider.identity);
  process.kill(provider.pid, "SIGCONT");
  await until(
    () =>
      !processes().some(
        (p) => p.pid === provider.pid && !p.status.startsWith("Z"),
      ),
    30000,
  );
  assert.equal(locked(), false);
  const files = readdirSync(resolve(committed, "..")).map((name) =>
    resolve(committed, "..", name),
  );
  const sha = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = files.map((file) => ({ file, sha256: sha(file) }));
  writeFileSync(orders, "id,amount\nBAD,12.50\n");
  const recovered = passed(
    await call("scheduler_retry", {
      occurrence: active.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(recovered.outcomes[0].runId, active.runId);
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 1);
  assert.deepEqual(
    files.map((file) => ({ file, sha256: sha(file) })),
    before,
  );
  assert.equal(recovered.state.work.find((w) => w.id === active.id).attempt, 3);
  const history = passed(
    await call("scheduler_history", { query: active.runId }),
  );
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].runId, active.runId);
  assert.equal(history.entries[0].status, "succeeded");
  assert.equal(history.entries[0].attempt, 3);
  checks.push(
    "original source commits 200000 orders and three customers after daemon death; same-run acknowledgement recovery returns that exact commit without reopening malformed source data, and complete history records all three attempts",
  );

  passed(
    await executeAsync(context, "scheduler_worker_stop", {
      id: replacement.id,
      interrupt: false,
    }),
  );
  await until(async () => {
    const w = await workerStatus(replacement.id);
    return w.status === "stopped" && !w.alive;
  });
  checks.push(
    "replacement driver drains and stops; both historical daemon records are terminal and no owned provider/source process remains active",
  );
  result = "passed";
} finally {
  for (const captured of [provider, source]) {
    if (
      captured &&
      identity(captured.pid) === captured.identity &&
      processes().some(
        (p) => p.pid === captured.pid && !p.status.startsWith("Z"),
      )
    ) {
      try {
        process.kill(captured.pid, "SIGCONT");
        process.kill(captured.pid, "SIGTERM");
      } catch {}
    }
  }
  for (const worker of [daemon, replacement]) {
    if (!worker) continue;
    try {
      passed(
        await executeAsync(context, "scheduler_worker_stop", {
          id: worker.id,
          interrupt: true,
        }),
      );
      await until(async () => !(await workerStatus(worker.id)).alive, 30000);
    } catch (error) {
      console.error("Owned worker cleanup failed", error.message);
    }
  }
  const workers = passed(
    await executeAsync(context, "scheduler_worker_status", {}),
  ).workers;
  const allStopped = workers.every(
    (w) => !w.alive && ["failed", "stopped"].includes(w.status),
  );
  await until(() => processes().every((p) => p.status.startsWith("Z")), 30000);
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result: result === "passed" && allStopped ? "passed" : "failed",
        checkedAt: new Date().toISOString(),
        root,
        checks,
        processes: {
          daemon: daemon?.pid,
          provider: provider?.pid,
          source: source?.pid,
          replacement: replacement?.pid,
        },
        workers: workers.map(({ id, status, alive, errorCode }) => ({
          id,
          status,
          alive,
          errorCode,
        })),
        coreVersion: JSON.parse(readFileSync(resolve(coreRoot, "package.json")))
          .version,
        cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
          .version,
        providerVersion: fixture.providerVersion,
        filesVersion: fixture.filesVersion,
        scope:
          "Actual isolated detached daemon death while an installed local/files source child is active; owned PID command and creation-time checks, residual lock refusal, real source commit, same-business-run recovery and history; synthetic file route only, no other source, cloud/native or browser qualification",
      },
      null,
      2,
    ) + "\n",
  );
  assert.equal(allStopped, true);
  console.log(JSON.stringify({ result, groups: checks.length, root }));
}
