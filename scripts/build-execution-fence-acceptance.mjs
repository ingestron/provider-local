/** Installed managed-build fence while real source processes remain active or uncertain. */
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
const root = mkdtempSync(resolve(output, "build-source-fence-"));
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
let daemon,
  daemonIdentity,
  provider,
  source,
  result = "failed",
  attemptedBuild;
const checks = [];
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function ownedFiles() {
  const manifest = JSON.parse(
    readFileSync(resolve(root, from, "ingestron-manifest.json")),
  );
  return ["ingestron-manifest.json", ...Object.keys(manifest.files)].map(
    (name) => ({ name, sha256: sha(resolve(root, from, name)) }),
  );
}
function rebuild() {
  return execute(context, "build", { flow: "bronze", out: from });
}
try {
  daemon = passed(
    await executeAsync(context, "scheduler_worker_start", {
      flows: ["bronze"],
      expectedDigests: { bronze: inspected.digest },
      pollSeconds: 1,
      limit: 1,
    }),
  ).worker;
  daemonIdentity = identity(daemon.pid);
  assert.ok(
    daemonIdentity?.includes(
      resolve(coreRoot, "dist/core/scheduler-worker-main.js"),
    ),
  );
  ({ provider, source } = await until(() => {
    const list = processes();
    const p = list.find(
      (v) => v.ppid === daemon.pid && v.command.includes("/execute.py"),
    );
    const s =
      p &&
      list.find(
        (v) =>
          v.ppid === p.pid && v.command.includes("/singer_runtime.py run "),
      );
    return s && locked()
      ? {
          provider: { ...p, identity: identity(p.pid) },
          source: { ...s, identity: identity(s.pid) },
        }
      : undefined;
  }));
  for (const p of [provider, source]) {
    assert.equal(identity(p.pid), p.identity);
    process.kill(p.pid, "SIGSTOP");
  }
  const active = passed(await call("scheduler_status")).state.work.find(
    (w) => w.status === "running",
  );
  assert.ok(active);
  const before = ownedFiles(),
    reviewFile = resolve(flowFolder, "review.json"),
    reviewBytes = sha(reviewFile);
  attemptedBuild = rebuild();
  assert.equal(
    attemptedBuild.ok,
    false,
    "An active source run must refuse generation into its managed build: " +
      JSON.stringify(attemptedBuild),
  );
  assert.equal(attemptedBuild.diagnostics[0].code, "EXECUTION_ACTIVE");
  assert.deepEqual(ownedFiles(), before);
  assert.equal(sha(reviewFile), reviewBytes);
  passed(
    execute(context, "build", { flow: "bronze", out: "build/independent" }),
  );
  const overlap = await call("run", { from, action: "run" });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.diagnostics[0].code, "EXECUTION_ACTIVE");
  checks.push(
    "actual live source refuses same-directory regeneration and overlapping execution before mutation; managed bytes and review remain unchanged, independent output directory compiles offline",
  );

  passed(
    await call("scheduler_pause", { expectedDigest: registered.bindingDigest }),
  );
  assert.equal(identity(daemon.pid), daemonIdentity);
  process.kill(daemon.pid, "SIGKILL");
  await until(async () => (await workerStatus(daemon.id)).recoveryRequired);
  passed(
    await executeAsync(context, "scheduler_worker_stop", {
      id: daemon.id,
      interrupt: true,
    }),
  );
  assert.equal(rebuild().diagnostics[0].code, "EXECUTION_ACTIVE");
  assert.deepEqual(ownedFiles(), before);
  assert.equal(sha(reviewFile), reviewBytes);
  const held = passed(
    await call("scheduler_retry", {
      occurrence: active.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(held.outcomes[0].status, "failed");
  assert.equal(held.outcomes[0].errorCode, "EXECUTION_ACTIVE");
  assert.equal(held.outcomes[0].runId, active.runId);
  assert.equal(locked(), true);
  checks.push(
    "daemon death and explicit driver release do not release the active build/source lease; same-run retry is refused while the original provider process group is held",
  );

  assert.equal(identity(source.pid), source.identity);
  process.kill(source.pid, "SIGCONT");
  const commit = await until(
    () => commits(resolve(root, from, "data/bronze"))[0],
    120000,
  );
  const receipt = JSON.parse(readFileSync(commit));
  assert.equal(receipt.identity.run_id, active.runId);
  assert.equal(receipt.tables.find((t) => t.stream === "orders").rows, 200000);
  const commitBytes = sha(commit);
  assert.equal(identity(provider.pid), provider.identity);
  process.kill(provider.pid, "SIGCONT");
  await until(
    () =>
      !processes().some(
        (p) => p.pid === provider.pid && !p.status.startsWith("Z"),
      ),
    30000,
  );
  assert.equal(rebuild().diagnostics[0].code, "EXECUTION_ACTIVE");
  writeFileSync(orders, "id,amount\nBAD,12.50\n");
  const recovered = passed(
    await call("scheduler_retry", {
      occurrence: active.id,
      expectedDigest: registered.bindingDigest,
    }),
  );
  assert.equal(recovered.outcomes[0].status, "succeeded");
  assert.equal(recovered.outcomes[0].runId, active.runId);
  assert.equal(sha(commit), commitBytes);
  assert.equal(commits(resolve(root, from, "data/bronze")).length, 1);
  assert.equal(recovered.state.work.find((w) => w.id === active.id).attempt, 3);
  passed(rebuild());
  assert.equal(sha(commit), commitBytes);
  assert.equal(sha(reviewFile), reviewBytes);
  checks.push(
    "dead caller and exited provider retain uncertain build ownership until explicit original-run recovery; acknowledgement replay returns the same 200000-row commit and then permits rebuilding without changing output or review",
  );
  result = "passed";
} finally {
  for (const p of [provider, source])
    if (
      p &&
      identity(p.pid) === p.identity &&
      processes().some((v) => v.pid === p.pid && !v.status.startsWith("Z"))
    ) {
      try {
        process.kill(p.pid, "SIGCONT");
        process.kill(p.pid, "SIGTERM");
      } catch {}
    }
  if (daemon) {
    try {
      passed(
        await executeAsync(context, "scheduler_worker_stop", {
          id: daemon.id,
          interrupt: true,
        }),
      );
      await until(async () => !(await workerStatus(daemon.id)).alive, 30000);
    } catch (e) {
      console.error("Owned daemon cleanup failed", e.message);
    }
  }
  await until(() => processes().every((p) => p.status.startsWith("Z")), 30000);
  const workers = passed(
    await executeAsync(context, "scheduler_worker_status", {}),
  ).workers;
  assert.ok(workers.every((w) => !w.alive));
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        checkedAt: new Date().toISOString(),
        root,
        checks,
        attemptedBuild,
        workers: workers.map(({ id, status, alive }) => ({
          id,
          status,
          alive,
        })),
        coreVersion: JSON.parse(readFileSync(resolve(coreRoot, "package.json")))
          .version,
        cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
          .version,
        providerVersion: fixture.providerVersion,
        filesVersion: fixture.filesVersion,
        scope:
          "Actual isolated installed local/files managed-build and overlapping-flow protection during live and uncertain source execution; original-run acknowledgement recovery; no shared physical target, other route, browser or native qualification",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result, groups: checks.length, root }));
}
