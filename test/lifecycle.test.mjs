import { test } from "node:test";
import assert from "node:assert/strict";
import { author } from "../src/lifecycle.mjs";
test("local project defaults require no Azure or workspace settings", () => {
  const result = author({
    apiVersion: "ingestron.provider-authoring/v1",
    operation: "initialise",
    provider: { source: "ingestron/provider-local", version: "0.4.1" },
    options: { id: "demo", environments: ["dev", "test"] },
  });
  const project = JSON.parse(result.files["project.yaml"]);
  assert.deepEqual(project.providers.packages, {
    local: { source: "ingestron/provider-local", version: "0.4.1" },
  });
  assert.deepEqual(JSON.parse(result.files["environments/dev.yaml"]).bindings, {
    runtime: { kind: "local" },
  });
  assert.throws(() =>
    author({
      apiVersion: "ingestron.provider-authoring/v1",
      operation: "initialise",
      options: { id: "demo", environments: ["../../bad"] },
    }),
  );
});
