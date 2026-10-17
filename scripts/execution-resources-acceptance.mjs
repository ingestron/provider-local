/** Installed offline resource declarations and actual locked local/files source execution. */
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
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
const root = mkdtempSync(resolve(required("OUTPUT"), "execution-resources-"));
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
const readonly = {
  root,
  environment: "dev",
  allowWrite: false,
  allowExecute: false,
  allowNetwork: false,
};
const projectFile = resolve(root, "project.yaml"),
  project = parse(readFileSync(projectFile, "utf8"));
for (const table of Object.values(project.flows[0].tables))
  table.source.path = table.source.path.replace(fixture.root, root);
writeFileSync(
  project.flows[0].tables.orders.source.path,
  "id,amount\n1,12.50\n2,14.25\n3,21.00\n",
);
const reference = "synthetic/local/plugin/provider.yaml@0.4.11";
project.packages.local = reference;
for (const id of ["silver", "gold"])
  project.flows.push({ ...structuredClone(project.flows[0]), id });
writeFileSync(projectFile, stringify(project));
passed(
  execute(context, "packages_install", {
    reference,
    fromGit: required("PROVIDER_ORIGIN"),
  }),
);
const from = "build/resources";
passed(execute(context, "build", { out: from }));
const checks = [],
  sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const manifest = resolve(root, from, "ingestron-manifest.json"),
  before = sha(manifest),
  lockBefore = sha(resolve(root, "packages.lock.yaml"));
const inspected = passed(
  await executeAsync(readonly, "execution_resources", {
    from,
    provider: "local",
  }),
);
assert.equal(inspected.coverage, "provider-declared");
assert.equal(inspected.resources.length, 3);
assert.deepEqual(
  inspected.flows.map((v) => v.flow),
  ["bronze", "gold", "silver"],
);
assert.ok(inspected.resources.every((v) => /^[a-f0-9]{64}$/.test(v)));
assert.equal(JSON.stringify(inspected).includes(root), false);
assert.equal(existsSync(resolve(root, ".ingestron/runs")), false);
assert.equal(existsSync(resolve(root, ".ingestron/scheduler")), false);
assert.equal(existsSync(resolve(root, from, "data")), false);
assert.equal(sha(manifest), before);
assert.equal(sha(resolve(root, "packages.lock.yaml")), lockBefore);
checks.push(
  "read-only installed SDK inspection returns three bounded opaque physical resource keys without source access, output, run/scheduler state or managed-file changes",
);
for (const flow of ["bronze", "silver", "gold"]) {
  const selected = passed(
    await executeAsync(readonly, "execution_resources", { from, flow }),
  );
  const registered = passed(
    await executeAsync(readonly, "scheduler_inspect", { from, flow }),
  );
  assert.deepEqual(
    selected.resources,
    inspected.flows.find((v) => v.flow === flow).resources,
  );
  assert.deepEqual(registered.binding.resources, selected.resources);
}
passed(execute(context, "build", { out: "build/independent", flow: "bronze" }));
const independent = passed(
  await executeAsync(readonly, "execution_resources", {
    from: "build/independent",
    flow: "bronze",
  }),
);
assert.notDeepEqual(
  independent.resources,
  inspected.flows.find((v) => v.flow === "bronze").resources,
);
checks.push(
  "every scheduler binding consumes its selected provider identity; a separate compiled output directory declares a separate actual data namespace",
);
const bad = await executeAsync(readonly, "execution_resources", {
  from,
  flow: "bronze",
  provider: "local",
});
assert.equal(bad.ok, false);
assert.equal(bad.diagnostics[0].code, "SELECT");
checks.push("ambiguous selections fail before any adapter starts");
passed(
  await executeAsync(context, "runtime_prepare", { from, flow: "bronze" }),
);
for (const action of ["discover", "review", "approve"])
  passed(await executeAsync(context, "run", { from, flow: "bronze", action }));
const first = passed(
  await executeAsync(context, "run", {
    from,
    flow: "bronze",
    runId: "resource_identity_actual",
  }),
);
assert.equal(first.status, "succeeded");
const commits = (folder) =>
  existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory()
          ? commits(resolve(folder, item.name))
          : item.name === "commit.json"
            ? [resolve(folder, item.name)]
            : [],
      )
    : [];
const files = commits(resolve(root, from, "data/bronze"));
assert.equal(files.length, 1);
const commit = JSON.parse(readFileSync(files[0]));
assert.equal(commit.tables.find((v) => v.stream === "orders").rows, 3);
const committed = sha(files[0]);
writeFileSync(
  project.flows[0].tables.orders.source.path,
  "id,amount\nBAD,12.50\n",
);
const replay = passed(await executeAsync(context, "run", { retry: first.id }));
assert.equal(replay.id, first.id);
assert.equal(replay.status, "succeeded");
assert.equal(sha(files[0]), committed);
assert.equal(existsSync(resolve(root, from, "data/silver")), false);
assert.equal(existsSync(resolve(root, from, "data/gold")), false);
assert.equal(sha(manifest), before);
checks.push(
  "actual locked local0.4.11/files1.5.8 source commits three orders to the declared bronze namespace and same-ID malformed-source retry preserves that commit; independent flows remain untouched",
);
writeFileSync(
  required("PROOF"),
  JSON.stringify(
    {
      result: "passed",
      checkedAt: new Date().toISOString(),
      root,
      checks,
      coreVersion: JSON.parse(readFileSync(resolve(coreRoot, "package.json")))
        .version,
      cliVersion: JSON.parse(readFileSync(resolve(cliRoot, "package.json")))
        .version,
      providerVersion: "0.4.11",
      filesVersion: fixture.filesVersion,
      resourceInspection: inspected,
      scope:
        "Installed provider-declared local physical output identities, scheduler consumption, read-only privacy, independent build resource separation and actual source/retry regression. Shared-target rejection has separate core ownership fixture evidence; cross-build/project durable reservations, source-parent death, other routes and native execution remain unqualified.",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ result: "passed", groups: checks.length, root }));
