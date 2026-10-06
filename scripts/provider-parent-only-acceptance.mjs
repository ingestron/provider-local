/** Actual direct caller stays alive while its provider dies and original source keeps writing. */
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
mkdirSync(required("OUTPUT"), { recursive: true });
const root = mkdtempSync(resolve(required("OUTPUT"), "parent-only-"));
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
    Array.from({ length: 200000 }, (_, i) => `${i + 1},12.50\n`).join(""),
);
writeFileSync(projectFile, stringify(project));
const from = "build/direct",
  flowFolder = resolve(root, from, "flows/bronze"),
  runId = "parent_only_original";
passed(execute(context, "build", { flow: "bronze", out: from }));
passed(await call("runtime_prepare", { from }));
for (const action of ["discover", "review", "approve"])
  passed(await call("run", { from, action }));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(30);
  }
  throw Error("Owned process observation timed out");
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
              ppid: Number(m[2]),
              status: m[3],
              command: m[4],
            },
          ]
        : [];
    });
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
const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function files(folder, name) {
  return existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory()
          ? files(resolve(folder, item.name), name)
          : item.name === name
            ? [resolve(folder, item.name)]
            : [],
      )
    : [];
}
function writerLocked() {
  return files(resolve(root, from, "data/bronze"), ".writer.lock").some(
    (path) =>
      execFileSync(
        "python3.12",
        [
          "-I",
          "-c",
          "import fcntl,sys; f=open(sys.argv[1],'r+');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('0')\nexcept BlockingIOError: print('1')",
          path,
        ],
        { encoding: "utf8" },
      ).trim() === "1",
  );
}
const ownedFiles = () => {
  const m = JSON.parse(
    readFileSync(resolve(root, from, "ingestron-manifest.json")),
  );
  return ["ingestron-manifest.json", ...Object.keys(m.files)].map((name) => ({
    name,
    sha256: sha(resolve(root, from, name)),
  }));
};
const rebuild = () => execute(context, "build", { flow: "bronze", out: from });
let provider,
  source,
  result = "failed",
  original;
const checks = [];
let observed;
try {
  original = call("run", { from, runId });
  ({ provider, source } = await until(() => {
    const list = processes(),
      p = list.find(
        (v) => v.ppid === process.pid && v.command.includes("/execute.py"),
      ),
      s =
        p &&
        list.find(
          (v) =>
            v.ppid === p.pid && v.command.includes("/singer_runtime.py run "),
        );
    return s && writerLocked()
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
  const before = ownedFiles(),
    review = sha(resolve(flowFolder, "review.json"));
  assert.equal(writerLocked(), true);
  assert.equal(rebuild().diagnostics[0].code, "EXECUTION_ACTIVE");
  checks.push(
    "actual source writer is held with confirmed caller/provider/source ownership; active generation is refused before mutation",
  );
  assert.equal(identity(provider.pid), provider.identity);
  process.kill(provider.pid, "SIGKILL");
  const initial = await original;
  assert.equal(initial.ok, false);
  process.kill(process.pid, 0);
  assert.equal(identity(source.pid), source.identity);
  assert.equal(writerLocked(), true);
  const status = passed(
    await executeAsync(
      {
        ...context,
        allowWrite: false,
        allowExecute: false,
        allowNetwork: false,
      },
      "run_status",
      { id: runId },
    ),
  );
  const initialRebuild = rebuild();
  const retry = await executeAsync(context, "run", { retry: runId });
  assert.equal(retry.ok, false);
  assert.notEqual(retry.diagnostics[0].code, "SELECT");
  assert.equal(writerLocked(), true);
  const retryStatus = passed(
    await executeAsync(
      {
        ...context,
        allowWrite: false,
        allowExecute: false,
        allowNetwork: false,
      },
      "run_status",
      { id: runId },
    ),
  );
  const retryRebuild = rebuild();
  observed = {
    initial,
    status,
    initialRebuild,
    retry,
    retryRebuild,
    retryStatus,
    sourceStillOwnsOutput: writerLocked(),
    callerRemainsAlive: true,
  };
  assert.equal(identity(source.pid), source.identity);
  process.kill(source.pid, "SIGCONT");
  const commit = await until(
      () => files(resolve(root, from, "data/bronze"), "commit.json")[0],
      120000,
    ),
    receipt = JSON.parse(readFileSync(commit));
  assert.equal(receipt.identity.run_id, runId);
  assert.equal(receipt.tables.find((v) => v.stream === "orders").rows, 200000);
  const committed = sha(commit);
  await until(
    () =>
      !processes().some(
        (p) => p.pid === source.pid && !p.status.startsWith("Z"),
      ),
    30000,
  );
  writeFileSync(
    required("OBSERVATION"),
    JSON.stringify(
      {
        result: !initialRebuild.ok && !retryRebuild.ok ? "passed" : "failed",
        checkedAt: new Date().toISOString(),
        root,
        observed,
        originalCommit: {
          path: commit,
          sha256: committed,
          runId,
          orders: 200000,
        },
        scope:
          "Actual provider-parent-only death with live direct caller and separately grouped source retaining output writer lock; initial transport failure and failed retry must preserve build ownership; original source commits afterwards.",
      },
      null,
      2,
    ) + "\n",
  );
  assert.equal(
    initialRebuild.ok,
    false,
    "Unacknowledged initial provider death must retain source ownership: " +
      JSON.stringify(observed),
  );
  assert.equal(initial.diagnostics[0].code, "EXECUTION_UNCERTAIN");
  for (const receipt of [status, retryStatus]) {
    assert.equal(receipt.status, "indeterminate");
    assert.equal(receipt.outcome, "uncertain");
    assert.equal(receipt.recoveryRequired, true);
    assert.equal(receipt.id, runId);
  }
  assert.equal(initialRebuild.diagnostics[0].code, "EXECUTION_ACTIVE");
  assert.equal(retryRebuild.ok, false);
  assert.equal(retryRebuild.diagnostics[0].code, "EXECUTION_ACTIVE");
  assert.deepEqual(ownedFiles(), before);
  assert.equal(sha(resolve(flowFolder, "review.json")), review);
  checks.push(
    "provider-parent death with live caller is distinguished from acknowledged source failure; both initial and failed retry preserve original uncertainty and unchanged build/review",
  );
  writeFileSync(orders, "id,amount\nBAD,12.50\n");
  const acknowledged = passed(
    await executeAsync(context, "run", { retry: runId }),
  );
  assert.equal(acknowledged.id, runId);
  assert.equal(acknowledged.status, "succeeded");
  assert.equal(acknowledged.outcome, "succeeded");
  assert.equal(acknowledged.recoveryRequired, false);
  assert.equal(sha(commit), committed);
  assert.equal(
    files(resolve(root, from, "data/bronze"), "commit.json").length,
    1,
  );
  passed(rebuild());
  assert.equal(sha(commit), committed);
  checks.push(
    "same-ID recovery acknowledges unchanged original200000-order commit despite malformed source, releases ownership and allows rebuilding",
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
  if (original) await original;
  await until(() => processes().every((p) => p.status.startsWith("Z")), 30000);
  writeFileSync(
    required("PROOF"),
    JSON.stringify(
      {
        result,
        checkedAt: new Date().toISOString(),
        root,
        checks,
        coreVersion: JSON.parse(readFileSync(resolve(coreRoot, "package.json")))
          .version,
        cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
          .version,
        providerVersion: fixture.providerVersion,
        filesVersion: fixture.filesVersion,
        scope:
          "Actual installed local/files provider-parent-only death with live direct caller, original source ownership and acknowledgement recovery. No other source route, shared physical target broker, browser or native execution qualification.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ result, groups: checks.length, root }));
}
