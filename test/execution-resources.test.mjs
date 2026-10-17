import test from "node:test";
import assert from "node:assert/strict";
import { command } from "../src/commands.mjs";
const inspect = (input) =>
  command({
    apiVersion: "ingestron.provider-command-request/v1",
    command: "execution resources",
    input,
  });
test("local provider declares the exact runtime data namespace independently of flow selection and package version", () => {
  const full = inspect({
    packageRoot: "/synthetic/project/build/provider",
    flows: ["orders", "customers"],
  });
  assert.deepEqual(full.flows[0], {
    flow: "orders",
    resources: [
      {
        namespace: "local-filesystem",
        identity: "/synthetic/project/build/provider/data/orders",
      },
    ],
  });
  assert.deepEqual(
    inspect({
      packageRoot: "/synthetic/project/build/provider",
      flows: ["orders"],
    }).flows[0],
    full.flows[0],
  );
  assert.notEqual(
    inspect({
      packageRoot: "/synthetic/project/another-build",
      flows: ["orders"],
    }).flows[0].resources[0].identity,
    full.flows[0].resources[0].identity,
  );
  for (const packageRoot of [
    "relative",
    "/tmp/../other",
    "/tmp//other",
    "/tmp\\other",
    "/",
  ])
    assert.throws(
      () => inspect({ packageRoot, flows: ["orders"] }),
      /canonical POSIX/,
    );
  for (const flows of [[], ["orders", "orders"], ["../private"], [null]])
    assert.throws(
      () => inspect({ packageRoot: "/synthetic/build", flows }),
      /canonical POSIX/,
    );
});
