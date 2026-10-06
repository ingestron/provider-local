import { object, text } from "./shape.mjs";
import { validateMetadataProjection } from "./metadata-projection.mjs";
export const runtimeContract = "ingestron.snapshot/python/v1";
const field = object(
  {
    type: {
      type: "string",
      enum: [
        "integer",
        "string",
        "boolean",
        "number",
        "decimal",
        "json",
        "date",
        "timestamp",
      ],
    },
    nullable: { type: "boolean" },
    target: { type: "string", minLength: 1 },
    precision: { type: "integer" },
    scale: { type: "integer" },
  },
  ["type", "nullable"],
);
export const selectionSchema = {
  type: "object",
  additionalProperties: object({
    name: text,
    fields: { type: "object", additionalProperties: field },
  }),
};
export const projectConnectionDefinition = {
  name: "connection prepare",
  description:
    "Prepare a project-resolved connection, selected fields and runtime-only secrets",
  inputSchema: { type: "object", additionalProperties: true },
};
export function validateProjectConnection(input, descriptor, projectionTables) {
  if (Object.hasOwn(input, "tableDocuments"))
    validateMetadataProjection(input, projectionTables);
  else if (projectionTables !== undefined)
    throw Error("Projection requires indexed connection metadata");
  const tables = projectionTables ?? input.tables;
  if (
    input.apiVersion !== "ingestron.connection-request/v1" ||
    !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/.test(input.connector) ||
    input.runtimeContract !== runtimeContract ||
    !input.specificationSha256
  )
    throw Error("Invalid project connection request");
  if (
    Object.keys(input).some(
      (k) =>
        ![
          "apiVersion",
          "project",
          "environment",
          "flow",
          "connection",
          "connector",
          "sourceId",
          "tenantId",
          "settings",
          "selection",
          "tables",
          "tableDocuments",
          "execution",
          "timeoutSeconds",
          "sourcePackage",
          "executionPackage",
          "specificationSha256",
          "runtimeAssetSha256",
          "runtimeContract",
          "schedule",
        ].includes(k),
    )
  )
    throw Error("Unknown project connection setting");
  if (Object.hasOwn(input, "schedule")) {
    // Core owns schema, calendar resolution and dispatch. The local adapter
    // verifies its scope/policies, then preserves the complete host envelope.
    const schedule = input.schedule;
    const keys = [
      "apiVersion",
      "owner",
      "clock",
      "definition",
      "boundaries",
      "digest",
    ];
    const ownerKeys = ["project", "environment", "flow", "connection"];
    const object = (value) =>
      value && typeof value === "object" && !Array.isArray(value);
    if (
      !object(schedule) ||
      Object.keys(schedule).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(schedule, key)) ||
      schedule.apiVersion !== descriptor.scheduling?.apiVersion ||
      schedule.clock !== "portable" ||
      descriptor.scheduling?.clock !== "portable" ||
      !object(schedule.owner) ||
      Object.keys(schedule.owner).length !== ownerKeys.length ||
      !ownerKeys.every(
        (key) =>
          typeof input[key] === "string" &&
          input[key].length > 0 &&
          schedule.owner[key] === input[key],
      ) ||
      !object(schedule.definition) ||
      schedule.definition.apiVersion !== "ingestron.schedule/v1" ||
      !descriptor.scheduling.recurrences.includes(
        schedule.definition.recurrence?.kind,
      ) ||
      !["skip", "queue"].includes(schedule.definition.overlap) ||
      !["skip", "latest"].includes(schedule.definition.missed) ||
      !object(schedule.boundaries) ||
      schedule.boundaries.apiVersion !== "ingestron.schedule-boundaries/v1" ||
      schedule.boundaries.timeZone !== schedule.definition.timeZone ||
      !/^[a-f0-9]{64}$/.test(schedule.digest) ||
      !/^[a-f0-9]{64}$/.test(input.specificationSha256)
    )
      throw Error(
        "Local execution requires a scope-bound reviewed portable schedule",
      );
  }
  if (input.tables && input.selection)
    throw Error("Use ODCS tables or legacy selection, never both");
  const incremental = input.execution?.ingestion === "incremental";
  if (incremental && !tables)
    throw Error(
      "Incremental append execution requires reviewed table policies",
    );
  for (const table of Object.values(tables ?? {}))
    if (!!table.source?.incremental !== incremental)
      throw Error(
        "Use an incremental policy on every table only in incremental execution",
      );
  const selection = tables ? selectionFromTables(tables) : input.selection;
  if (
    !conforms(descriptor.settingsSchema, input.settings) ||
    !conforms(descriptor.selectionSchema, selection) ||
    !conforms(descriptor.executionSchema, input.execution)
  )
    throw Error("Invalid connector settings, selection or execution");
  const values = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$secret) values.push(value);
    else Object.values(value).forEach(visit);
  }
  visit(input.settings);
  if (input.execution.mode === "adf-batch" && values.some((v) => v.$secret.env))
    throw Error("Batch execution requires Key Vault secret references");
  for (const value of values)
    if (value?.$secret) {
      const ref = value.$secret;
      if (
        ref.env
          ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env)
          : !(
              /^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net$/.test(
                ref.vaultUrl,
              ) &&
              /^[A-Za-z0-9-]{1,127}$/.test(ref.name) &&
              /^[a-fA-F0-9-]{36}$/.test(ref.identityClientId)
            )
      )
        throw Error("Invalid runtime secret reference");
    }
  const names = Object.values(selection).map((table) => table.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  )
    throw Error("Invalid or duplicate selected table name");
  // Discovery-only builds (every table still without a contract) select nothing yet.
  const discoveryOnly =
    tables && Object.values(tables).every((t) => !t.contract);
  if (!Object.keys(selection).length && !discoveryOnly)
    throw Error("Select at least one source stream");
  for (const [stream, table] of Object.entries(selection)) {
    if (!/^[A-Za-z0-9_-]+$/.test(stream) || !Object.keys(table.fields).length)
      throw Error("Select safe stream IDs and fields");
  }
  for (const table of Object.values(selection))
    for (const [name, field] of Object.entries(table.fields)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw Error("Invalid selected field");
      if (
        field.type === "decimal"
          ? !(
              Number.isInteger(field.precision) &&
              field.precision >= 1 &&
              field.precision <= 38 &&
              Number.isInteger(field.scale) &&
              field.scale >= 0 &&
              field.scale <= field.precision
            )
          : field.precision !== undefined || field.scale !== undefined
      )
        throw Error("Invalid decimal precision/scale");
    }
  for (const table of Object.values(selection)) {
    const targets = Object.entries(table.fields).map(
      ([source, field]) => field.target ?? source,
    );
    if (
      new Set(targets).size !== targets.length ||
      targets.some((target) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target))
    )
      throw Error("Invalid or duplicate target field");
  }
  return selection;
}

export function conforms(schema, value) {
  const allowed = new Set([
    "type",
    "oneOf",
    "properties",
    "items",
    "required",
    "additionalProperties",
    "enum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
  ]);
  if (
    !schema ||
    typeof schema !== "object" ||
    Object.keys(schema).some((k) => !allowed.has(k))
  )
    throw Error("Unsupported connector schema keyword");
  if (
    schema.oneOf &&
    schema.oneOf.filter((s) => conforms(s, value)).length !== 1
  )
    return false;
  if (
    schema.enum &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  )
    return false;
  const isObject =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const types = {
    object: isObject,
    array: Array.isArray(value),
    integer: Number.isInteger(value),
    number: typeof value === "number" && Number.isFinite(value),
    string: typeof value === "string",
    boolean: typeof value === "boolean",
    null: value === null,
  };
  if (schema.type && !types[schema.type]) return false;
  if (
    typeof value === "number" &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    return false;
  if (
    typeof value === "string" &&
    (Array.from(value).length < (schema.minLength ?? 0) ||
      Array.from(value).length > (schema.maxLength ?? Infinity))
  )
    return false;
  if (
    Array.isArray(value) &&
    (value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity) ||
      (schema.items && !value.every((v) => conforms(schema.items, v))))
  )
    return false;
  if (isObject) {
    if (!(schema.required ?? []).every((k) => Object.hasOwn(value, k)))
      return false;
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        if (!conforms(schema.properties[key], child)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (
        typeof schema.additionalProperties === "object" &&
        !conforms(schema.additionalProperties, child)
      )
        return false;
    }
  }
  return true;
}

export function selectionFromTables(tables) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables))
    throw Error("Invalid ODCS table map");
  const selected = {};
  const streams = new Set();
  for (const [name, table] of Object.entries(tables)) {
    if (!table.source?.stream || streams.has(table.source.stream))
      throw Error("Invalid or duplicate contracted stream");
    streams.add(table.source.stream);
    // Discovery runs before contracts exist (PB-064 phase 6); such tables
    // have no selection yet, and review refuses them until a contract is set.
    if (
      !table.contract &&
      Array.isArray(table.columns) &&
      !table.columns.length
    )
      continue;
    if (
      !table.contract ||
      !Array.isArray(table.columns) ||
      !table.columns.length
    )
      throw Error("Invalid or duplicate contracted stream");
    const fields = {};
    const targets = new Set();
    for (const column of table.columns) {
      const type = column.type.toUpperCase();
      const mapped = {
        STRING: "string",
        BIGINT: "integer",
        INT: "integer",
        INTEGER: "integer",
        SMALLINT: "integer",
        DOUBLE: "number",
        FLOAT: "number",
        BOOLEAN: "boolean",
        DATE: "date",
        TIMESTAMP: "timestamp",
      }[type];
      const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(type);
      if (!mapped && !decimal)
        throw Error(
          `Snapshot projection does not support ODCS physical type ${type}`,
        );
      const target = column.target ?? column.name;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || targets.has(target))
        throw Error("Invalid or duplicate target field");
      targets.add(target);
      fields[column.name] = decimal
        ? {
            type: "decimal",
            precision: Number(decimal[1]),
            scale: Number(decimal[2]),
            nullable: !column.required,
            ...(target !== column.name ? { target } : {}),
          }
        : {
            type: mapped,
            nullable: !column.required,
            ...(target !== column.name ? { target } : {}),
          };
    }
    selected[table.source.stream] = { name, fields };
  }
  return selected;
}
