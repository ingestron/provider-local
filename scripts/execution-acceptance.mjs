/** Installed public CLI/core boundary, with an independent source package. */
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import assert from "node:assert/strict";
const temp = mkdtempSync(resolve(tmpdir(), "ion-execution-"));
const project = resolve(
  process.env.INGESTRON_TEST_SOURCE_DIRECTORY
    ? "build/source-acceptance"
    : "build/execution-acceptance",
);
rmSync(project, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
const cli = resolve(".cli-host/node_modules/ingestron/build/cli/cli/index.js");
const host = JSON.parse(
  readFileSync(".cli-host/node_modules/ingestron/package.json"),
);
const baseline = JSON.parse(readFileSync("scripts/cli-baseline.json"));
assert.equal(host.version, baseline.cli);
assert.equal(host.dependencies["@ingestron/core"], baseline.core);
const core = JSON.parse(
  readFileSync(".cli-host/node_modules/@ingestron/core/package.json"),
);
assert.equal(core.version, baseline.core);
const { syntheticSource } = await import("./synthetic-source.mjs");
const sourceDirectory = process.env.INGESTRON_TEST_SOURCE_DIRECTORY;
const sourceVersion = sourceDirectory
  ? parse(
      readFileSync(resolve(sourceDirectory, "faker/connector.yaml"), "utf8"),
    ).version
  : "1.0.0";
const sourceRef = sourceDirectory
  ? `example/source/connectors/faker/connector.yaml@${sourceVersion}`
  : "example/source/connector.yaml@1.0.0";
try {
  const origin = (id, source, folder, tag) => {
    const root = resolve(temp, id);
    mkdirSync(root);
    cpSync(source, resolve(root, folder), {
      recursive: true,
      filter: (p) => !p.includes("__pycache__"),
    });
    const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    git("tag", tag);
    return root;
  };
  const version = JSON.parse(readFileSync("package.json")).version;
  const local = origin("local", resolve("plugin"), "plugin", version);
  const fixture = resolve(temp, "fixture");
  syntheticSource(fixture);
  const source = origin(
    "source",
    sourceDirectory || fixture,
    sourceDirectory ? "connectors" : ".",
    sourceVersion,
  );
  const p = parse(readFileSync("examples/synthetic/project.yaml", "utf8"));
  if (sourceDirectory)
    p.connections.demo.settings = { count: 3, seed: 42, parallelism: 1 };
  p.providers = {
    packages: {
      local: "ingestron/provider-local@" + version,
      synthetic: sourceRef,
    },
    configurations: { local: { package: "local", binding: "runtime" } },
  };
  p.packages = p.providers.packages;
  delete p.providers.packages;
  p.flows = p.flows.filter((f) => f.provider === "local");
  p.environments.dev.bindings = { runtime: { kind: "local" } };
  const contract = structuredClone(p.flows[0].tables.users.contract);
  const modelFixture = resolve(temp, "model-fixture");
  mkdirSync(modelFixture);
  writeFileSync(
    resolve(modelFixture, "pack.yaml"),
    stringify({
      apiVersion: "ingestron.extension-pack/v2",
      kind: "model",
      id: "synthetic-model",
      description: "Synthetic model contract for installed provider acceptance",
      version: "1.0.0",
      contracts: { users: contract },
      provenance: {
        sources: ["test-only synthetic fixture"],
        retrieved: "2026-09-25",
        status: "documented-projection",
        notes: "No real source or personal data",
      },
    }),
  );
  const modelOrigin = origin("models", modelFixture, ".", "1.0.0");
  p.modelPacks = {
    demo: { source: "example/models/pack.yaml", version: "1.0.0" },
  };
  p.flows[0].tables.users.contract = { $model: "demo:users" };
  p.flows.push({ ...structuredClone(p.flows[0]), id: "users_second" });
  writeFileSync(resolve(project, "project.yaml"), stringify(p));
  const call = (ok, ...args) => {
    const proc = spawnSync(
      process.execPath,
      [cli, "--project", project, "--json", "--no-input", ...args],
      { encoding: "utf8", timeout: 1_800_000, maxBuffer: 2_000_000 },
    );
    let r;
    try {
      r = JSON.parse(proc.stdout);
    } catch {
      throw Error(proc.stderr + proc.stdout);
    }
    assert.equal(proc.error, undefined);
    assert.equal(proc.status === 0, ok, proc.stdout + proc.stderr);
    assert.equal(r.ok, ok, JSON.stringify(r));
    return r;
  };
  call(
    true,
    "plugin",
    "install",
    "ingestron/provider-local@" + version,
    ...(process.env.INGESTRON_TEST_PUBLIC_PROVIDER === "1"
      ? []
      : ["--from-git", local]),
    "--cache-only",
  );
  call(
    true,
    "plugin",
    "install",
    sourceRef,
    "--from-git",
    source,
    "--cache-only",
  );
  call(
    true,
    "plugin",
    "install",
    "example/models/pack.yaml@1.0.0",
    "--from-git",
    modelOrigin,
    "--cache-only",
  );
  call(true, "plugin", "show", "local");
  writeFileSync(
    resolve(project, "contract-request.json"),
    JSON.stringify({
      review: {
        apiVersion: "ingestron.singer-review/v1",
        status: "approved",
        contracts: { users: contract },
      },
    }),
  );
  const exported = call(
    true,
    "local",
    "connector",
    "contracts",
    "--target",
    "local",
    "--input",
    "contract-request.json",
  );
  assert.match(JSON.stringify(exported), /users.odcs.json/);
  call(true, "build");
  const missing = call(
    false,
    "run",
    "--action",
    "discover",
    "--provider",
    "local",
  );
  assert.match(JSON.stringify(missing), /runtime prepare/);
  call(true, "runtime", "prepare", "--provider", "local");
  const second = call(true, "runtime", "prepare", "--provider", "local");
  assert.ok(second.result.result.flows.every((f) => f.reused));
  assert.equal(
    new Set(second.result.result.flows.map((f) => f.environment)).size,
    1,
  );
  call(true, "run", "--provider", "local", "--action", "discover");
  call(true, "run", "--provider", "local", "--action", "review");
  const rejected = call(
    false,
    "run",
    "--provider",
    "local",
    "--run-id",
    "draft",
  );
  assert.match(JSON.stringify(rejected), /Run draft/);
  for (const id of ["users_local", "users_second"]) {
    const r = JSON.parse(
      readFileSync(
        resolve(project, "build/generated/flows", id, "review.json"),
      ),
    );
    assert.equal(r.status, "draft");
    assert.deepEqual(Object.keys(r.selection.users.fields).sort(), [
      "age",
      "id",
    ]);
  }
  call(true, "run", "--provider", "local", "--action", "approve");
  const run = call(true, "run", "--provider", "local", "--run-id", "demo-001");
  assert.ok(run.result.result.flows.every((f) => f.tables[0].rows === 3));
  if (!sourceDirectory) {
    const rows = JSON.parse(
      readFileSync(
        resolve(
          project,
          "build/generated/data/users_local/demo-001/users.json",
        ),
      ),
    );
    assert.deepEqual(rows, [
      { id: 0, age: 20 },
      { id: 1, age: 21 },
      { id: 2, age: 22 },
    ]);
  }
  if (sourceDirectory) {
    const checked = execFileSync(
      "python3",
      [
        "-c",
        `
import json, pathlib, subprocess
root = pathlib.Path(${JSON.stringify(project)})
python = next((root / '.ingestron/runtimes').glob('*/bin/python'))
files = list((root / 'build/generated/data').rglob('users.parquet'))
assert len(files) == 2
for file in files:
    subprocess.run([str(python), '-c', "import sys,pyarrow.parquet as p;t=p.read_table(sys.argv[1]);assert t.num_rows==3;assert sorted(t.column_names)==['age','id']", str(file)], check=True)
print('Two Parquet files: three rows and id/age columns verified')
`,
      ],
      { encoding: "utf8" },
    );
    console.log(checked.trim());
  }
  const retry = call(true, "run", "--retry", "demo-001");
  assert.equal(retry.result.attempt, 2);
  assert.deepEqual(retry.result.result.flows, run.result.result.flows);
  const status = call(true, "run", "status", "demo-001");
  assert.equal(status.result.status, "succeeded");
  const original = readFileSync(resolve(project, "project.yaml"), "utf8");
  writeFileSync(resolve(project, "project.yaml"), original + "\n# changed\n");
  call(false, "run", "--retry", "demo-001");
  writeFileSync(resolve(project, "project.yaml"), original);
  writeFileSync(
    resolve(project, "build/evidence.json"),
    JSON.stringify(
      {
        passed: true,
        cli: host.version,
        core: core.version,
        source: sourceDirectory
          ? "private Airbyte Faker qualification"
          : "synthetic JSON fixture",
        local: version,
        managedEnvironment: true,
        modelContractResolved: true,
        storedRowsReadBack: true,
        flows: 2,
        rowsPerFlow: 3,
        retry: true,
        status: true,
        unapprovedRejected: true,
        staleRejected: true,
        cloudExecuted: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "Managed local execution, shared environment, review, extraction, retry and status passed",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
