import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare as projectConnectionPrepare } from "../src/commands.mjs";
function input() {
  return {
    apiVersion: "ingestron.connection-request/v1",
    specificationSha256: "synthetic",
    runtimeContract: "ingestron.snapshot/python/v1",
    runtimeAssetSha256: "locked",
    runtimeAssets: {
      "singer_azure.py": "# synthetic entry point, never executed\n",
      "settings.schema.json": JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["password"],
        properties: {
          host: { type: "string" },
          port: { type: "integer" },
          user: { type: "string" },
          database: { type: "string" },
          filter_schemas: { type: "array", items: { type: "string" } },
          default_replication_method: { type: "string" },
          password: {
            type: "object",
            required: ["$secret"],
            additionalProperties: false,
            properties: {
              $secret: { type: "object", additionalProperties: true },
            },
          },
        },
      }),
      "runtime.lock.json": JSON.stringify({
        connector: "example@1.0.0",
        files: {},
      }),
    },
    connector: "fixture:example@1.0.0",
    sourceId: "erp",
    tenantId: "nz",
    timeoutSeconds: 60,
    settings: {
      host: "localhost",
      port: 5432,
      user: "reader",
      password: { $secret: { env: "PG_PASSWORD" } },
      database: "sales",
      filter_schemas: ["public"],
      default_replication_method: "FULL_TABLE",
    },
    selection: {
      "public-orders": {
        name: "orders",
        fields: { id: { type: "integer", nullable: false } },
      },
    },
    execution: { mode: "local" },
  };
}
test("project preparation embeds only references, projection and immutable input provenance", () => {
  const result = projectConnectionPrepare(input());
  const config = JSON.parse(result.artifacts["connector.json"]);
  assert.deepEqual(config.sourceSettings.password, {
    $secret: { env: "PG_PASSWORD" },
  });
  assert.ok(result.artifacts["selection.json"]);
  assert.ok(result.artifacts["project-connection.lock.json"]);
  assert.equal(config.projectLock.connector, "fixture:example@1.0.0");
});
test("direct command rejects plaintext credentials, unsupported options and empty projection", () => {
  let i = input();
  i.settings.password = "dummy";
  assert.throws(() => projectConnectionPrepare(i));
  i = input();
  i.settings.typo = true;
  assert.throws(() => projectConnectionPrepare(i));
  i = input();
  i.selection = {};
  assert.throws(() => projectConnectionPrepare(i));
  i = input();
  i.selection["public-orders"].fields.id = { type: "decimal", nullable: false };
  assert.throws(() => projectConnectionPrepare(i));
});

test("ODCS columns derive the runtime projection; unsupported types fail explicitly", () => {
  const i = input();
  delete i.selection;
  i.tables = {
    orders: {
      source: { stream: "public-orders" },
      contract: { apiVersion: "v3.1.0", id: "sales-orders" },
      columns: [
        { name: "amount", type: "DECIMAL(20,2)", required: true, key: false },
      ],
    },
  };
  const result = projectConnectionPrepare(i);
  assert.deepEqual(JSON.parse(result.artifacts["selection.json"]), {
    "public-orders": {
      name: "orders",
      fields: {
        amount: { type: "decimal", precision: 20, scale: 2, nullable: false },
      },
    },
  });
  assert.equal(
    JSON.parse(result.artifacts["connector.json"]).projectLock.tables.orders
      .contract.id,
    "sales-orders",
  );
  i.tables.orders.columns[0].type = "DATE";
  assert.throws(() => projectConnectionPrepare(i), /does not support/);
});

test("runtime capability accepts a source unknown to the engine and rejects another ABI", () => {
  assert.equal(projectConnectionPrepare(input()).connector, "example@1.0.0");
  const i = input();
  i.runtimeContract = "unknown/v2";
  assert.throws(
    () => projectConnectionPrepare(i),
    /Invalid project connection/,
  );
});

test("local preparation rejects cloud mode, unsafe identity, timeout and missing source assets", () => {
  for (const mutate of [
    (i) => (i.execution = { mode: "adf-batch" }),
    (i) => (i.sourceId = "../escape"),
    (i) => (i.timeoutSeconds = 0),
    (i) => delete i.runtimeAssets,
    (i) => (i.runtimeAssets["runtime.lock.json"] = '{"connector":"wrong"}'),
  ]) {
    const i = input();
    mutate(i);
    assert.throws(() => projectConnectionPrepare(i));
  }
  const result = projectConnectionPrepare(input());
  assert.equal(result.applied, false);
  assert.equal(result.artifacts["pipeline.arm.json"], undefined);
  assert.equal(JSON.parse(result.artifacts["connector.json"]).azure, undefined);
});
