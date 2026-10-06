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

test("temporal ODCS projections retain source and target identities with exact nullable semantics", () => {
  const selected = selectionFromTables({
    events: {
      contract: { apiVersion: "v3.1.0" },
      source: { stream: "events" },
      columns: [
        { name: "day", target: "business_day", type: "DATE", required: true },
        { name: "event", type: "TIMESTAMP", required: false },
      ],
    },
  });
  assert.deepEqual(selected.events.fields, {
    day: { type: "date", nullable: false, target: "business_day" },
    event: { type: "timestamp", nullable: true },
  });
});
