/** Own-process crash/acknowledgement loss against the actual installed file route. */
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
import { spawn, execFileSync } from "node:child_process";
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
const root = mkdtempSync(resolve(output, "source-crash-"));
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
const cli = resolve(cliRoot, "build/cli/cli/index.js");
let worker,
  provider,
  source,
  result = "failed";
const checks = [];
try {
  worker = spawn(
    process.execPath,
    [
      cli,
      "--project",
      root,
      "--json",
      "--no-input",
      "operation",
      "scheduler_tick",
      "--allow-write",
      "--allow-execute",
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) =>
    worker.once("exit", (code, signal) => resolve({ code, signal })),
  );
  worker.stdout.resume();
  worker.stderr.resume();
  worker.stdin.end(JSON.stringify({ flow: "bronze", limit: 1 }));
  ({ provider, source } = await until(() => {
    const list = processes(),
      p = list.find(
        (item) =>
          item.ppid === worker.pid && item.command.includes("/execute.py"),
      );
    if (!p) return;
    const s = list.find(
      (item) =>
        item.ppid === p.pid && item.command.includes("/singer_runtime.py run "),
    );
    return s && locked() ? { provider: p, source: s } : undefined;
  }));
  assert.ok(provider.pid !== process.pid && source.pid !== process.pid);
  process.kill(provider.pid, "SIGSTOP");
  const running = passed(await call("scheduler_status")),
    occurrence = running.state.work.find((item) => item.status === "running");
  assert.ok(occurrence);
  assert.equal(occurrence.workerPid, worker.pid);
  const denied = await call("scheduler_retry", {
    occurrence: occurrence.id,
    expectedDigest: registered.bindingDigest,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].code, "SCHEDULE_ACTIVE");
  checks.push(
    "actual live caller/source claim refuses recovery before worker death",
  );
  worker.kill("SIGKILL");
  assert.equal((await exited).signal, "SIGKILL");
  const interrupted = passed(await call("scheduler_status"));
  assert.equal(
    interrupted.state.work.find((item) => item.id === occurrence.id).status,
    "running",
  );
  const refused = passed(
    await call("scheduler_retry", {
      occurrence: occurrence.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(refused.outcomes[0].status, "failed");
  assert.equal(refused.outcomes[0].runId, occurrence.runId);
  assert.equal(locked(), true);
  checks.push(
    "dead caller recovery cannot execute through the still-live provider's held flow lock",
  );
  const committed = await until(
    () => commits(resolve(root, from, "data/bronze"))[0],
    120000,
  );
  const receipt = JSON.parse(readFileSync(committed, "utf8"));
  assert.equal(receipt.identity.run_id, occurrence.runId);
  assert.equal(
    receipt.tables.find((item) => item.stream === "orders").rows,
    200000,
  );
  assert.equal(
    receipt.tables.find((item) => item.stream === "customers").rows,
    3,
  );
  checks.push(
    "original real source commits once while its caller is dead and acknowledgement is unavailable",
  );
  process.kill(provider.pid, "SIGCONT");
  await until(
    () =>
      !processes().some(
        (item) => item.pid === provider.pid && !item.status.startsWith("Z"),
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
      occurrence: occurrence.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(recovered.outcomes[0].runId, occurrence.runId);
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 1);
  assert.deepEqual(
    files.map((file) => ({ file, sha256: sha(file) })),
    before,
  );
  assert.equal(
    recovered.state.work.find((item) => item.id === occurrence.id).attempt,
    3,
  );
  checks.push(
    "post-commit acknowledgement-loss recovery returns the same business commit without reopening malformed source data",
  );
  result = "passed";
} finally {
  // Only captured children in this disposable root are eligible for cleanup.
  for (const captured of [provider, source])
    if (
      captured &&
      processes().some(
        (item) =>
          item.pid === captured.pid &&
          item.command === captured.command &&
          !item.status.startsWith("Z"),
      )
    ) {
      try {
        process.kill(captured.pid, "SIGCONT");
        process.kill(captured.pid, "SIGTERM");
      } catch {}
    }
  if (worker && worker.exitCode === null && worker.signalCode === null)
    worker.kill("SIGTERM");
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        checkedAt: new Date().toISOString(),
        root,
        checks,
        processes: {
          worker: worker?.pid,
          provider: provider?.pid,
          source: source?.pid,
        },
        archives: fixture.archives,
        providerVersion: fixture.providerVersion,
        filesVersion: fixture.filesVersion,
        scope:
          "Actual isolated caller process death, live provider lock refusal, real source commit and acknowledgement-loss same-run recovery; synthetic file route only, no other sources or native execution",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result, checks: checks.length, root }));
}
