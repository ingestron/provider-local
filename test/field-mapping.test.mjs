import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionFromTables } from "../src/contracts/connection-contract.mjs";

test("ODCS target names survive provider selection", () => {
  const selected = selectionFromTables({
    customers: {
      contract: { apiVersion: "v3.1.0" },
      source: { stream: "customers" },
      columns: [
        { name: "id", target: "customer_id", type: "BIGINT", required: true },
      ],
    },
  });
  assert.deepEqual(selected.customers.fields.id, {
    type: "integer",
    nullable: false,
    target: "customer_id",
  });
});
