import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../src/project-assembly.mjs";
const scope = { id: "full", partial: false, flows: ["a", "b"] };
const flow = (id) => ({
  flow: id,
  artifacts: {
    "connector.json": JSON.stringify({
      timeoutSeconds: 20,
      projectLock: {
        runtimeAssetSha256: "same",
        sourcePackage: { reference: "example/source/connector.yaml@1.0.0" },
      },
    }),
    "requirements.lock.txt": "locked",
    "build-tools.lock.txt": "tools",
  },
});
test("local project has one dependency environment and selectable isolated flow folders", () => {
  const r = assemble({
    phase: "assemble",
    project: "demo",
    environment: "dev",
    configuration: "local",
    scope,
    nativeFiles: {},
    connections: [flow("a"), flow("b")],
  });
  const p = JSON.parse(r.artifacts["project-runtime.json"]);
  assert.equal(Object.keys(p.environments).length, 1);
  assert.equal(Object.keys(p.flows).length, 2);
  assert.ok(r.artifacts["run.py"]);
  assert.ok(r.artifacts["flows/a/connector.json"]);
  assert.throws(() =>
    assemble({
      phase: "assemble",
      scope,
      nativeFiles: { "native.json": "{}" },
      connections: [],
    }),
  );
  assert.throws(() =>
    assemble({
      phase: "assemble",
      scope,
      nativeFiles: {},
      connections: [flow("../unsafe")],
    }),
  );
});

test("runner preserves virtual environment interpreter identity", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { runner } = await import("../src/project-runner.mjs");
  const root = mkdtempSync(join(tmpdir(), "local-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("python3", ["-m", "venv", "--without-pip", join(root, "venv")]);
  mkdirSync(join(root, "flows/a"), { recursive: true });
  writeFileSync(join(root, "run.py"), runner);
  writeFileSync(
    join(root, "project-runtime.json"),
    JSON.stringify({ flows: { a: { directory: "flows/a" } } }),
  );
  writeFileSync(
    join(root, "flows/a/singer_runtime.py"),
    'import sys\nassert sys.prefix != sys.base_prefix, "Lost virtual environment"\n',
  );
  const output = execFileSync(
    "python3",
    [
      join(root, "run.py"),
      "discover",
      "--all",
      "--python",
      join(root, "venv/bin/python"),
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /a: discover succeeded/);
});

test("standalone runner defaults to the active interpreter", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { runner } = await import("../src/project-runner.mjs");
  const root = mkdtempSync(join(tmpdir(), "runner-default-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("python3", ["-m", "venv", "--without-pip", join(root, "venv")]);
  mkdirSync(join(root, "flows/a"), { recursive: true });
  writeFileSync(join(root, "run.py"), runner);
  writeFileSync(
    join(root, "project-runtime.json"),
    JSON.stringify({ flows: { a: { directory: "flows/a" } } }),
  );
  writeFileSync(
    join(root, "flows/a/singer_runtime.py"),
    "import sys\nassert sys.prefix != sys.base_prefix\n",
  );
  assert.match(
    execFileSync(
      join(root, "venv/bin/python"),
      [join(root, "run.py"), "discover", "--all"],
      { encoding: "utf8" },
    ),
    /succeeded/,
  );
});
