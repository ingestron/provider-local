import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prepare, connectorRuntimes } from "../src/commands.mjs";
import { assemble } from "../src/project-assembly.mjs";
const { fixtures } = JSON.parse(
  readFileSync(new URL("./fixtures/portable-schedules.json", import.meta.url)),
);
const canonical = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, child[key]]),
        )
      : child,
  );
function request(schedule) {
  const body = {
    apiVersion: "ingestron.connection-request/v1",
    runtimeContract: "ingestron.snapshot/python/v1",
    project: "retail",
    environment: "dev",
    flow: "bronze",
    connection: "files",
    connector: "fixture:example@1.0.0",
    sourceId: "retail",
    tenantId: "synthetic",
    runtimeAssetSha256: "a".repeat(64),
    settings: {},
    timeoutSeconds: 60,
    execution: { mode: "local" },
    selection: {
      orders: {
        name: "orders",
        fields: { id: { type: "integer", nullable: false } },
      },
    },
    ...(schedule ? { schedule: structuredClone(schedule) } : {}),
  };
  return {
    ...body,
    specificationSha256: createHash("sha256")
      .update(canonical(body))
      .digest("hex"),
    runtimeAssets: {
      "settings.schema.json": JSON.stringify({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      "runtime.lock.json": JSON.stringify({
        connector: "example@1.0.0",
        files: {},
      }),
      "requirements.lock.txt": "# fixture\n",
      "build-tools.lock.txt": "# fixture\n",
    },
  };
}
test("local adapter retains complete core-owned schedule intent in every scoped runtime artifact", () => {
  assert.deepEqual(
    connectorRuntimes["ingestron.snapshot/python/v1"].scheduling.recurrences,
    ["interval", "daily", "weekly", "monthly"],
  );
  for (const schedule of fixtures) {
    const input = request(schedule),
      output = prepare(input);
    const lock = JSON.parse(output.artifacts["project-connection.lock.json"]);
    assert.deepEqual(lock.schedule, schedule);
    assert.deepEqual(
      JSON.parse(output.artifacts["connector.json"]).projectLock,
      lock,
    );
    const project = assemble({
      phase: "assemble",
      project: "retail",
      environment: "dev",
      configuration: "local",
      scope: { flows: ["bronze"] },
      nativeFiles: {},
      connections: [{ flow: "bronze", artifacts: output.artifacts }],
    });
    assert.deepEqual(
      JSON.parse(project.artifacts["flows/bronze/connector.json"]).projectLock
        .schedule,
      schedule,
    );
    assert.equal(project.details.execution, "not-run");
    assert.equal(JSON.stringify(project).includes("schedule.py"), false);
  }
});
test("local adapter refuses foreign scope, native policies and unsupported handovers before preparation", () => {
  const mutations = [
    (input) => (input.schedule = null),
    (input) => (input.schedule.owner.flow = "other"),
    (input) => (input.schedule.owner.connection = "other"),
    (input) => (input.schedule.owner.extra = "foreign"),
    (input) => delete input.environment,
    (input) => (input.schedule.clock = "platform-native"),
    (input) => (input.schedule.definition.overlap = "native"),
    (input) => (input.schedule.definition.missed = "native"),
    (input) => (input.schedule.definition.recurrence.kind = "cron"),
    (input) => (input.schedule.boundaries.timeZone = "other"),
    (input) => (input.schedule.apiVersion = "foreign/v1"),
    (input) => (input.schedule.digest = "not-a-digest"),
    (input) => (input.specificationSha256 = "not-a-digest"),
    (input) => delete input.schedule.boundaries,
    (input) => (input.schedule.launch = true),
  ];
  for (const mutate of mutations) {
    const input = request(fixtures[0]);
    mutate(input);
    assert.throws(
      () => prepare(input),
      /scope-bound reviewed portable schedule/,
    );
  }
});
test("manual local preparation retains its previous request shape without invented schedule intent", () => {
  const input = request(),
    output = prepare(input);
  assert.equal(
    Object.hasOwn(
      JSON.parse(output.artifacts["connector.json"]).projectLock,
      "schedule",
    ),
    false,
  );
});
