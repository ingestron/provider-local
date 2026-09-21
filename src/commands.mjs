import { assemble } from "./project-assembly.mjs";
import {
  runtimeContract,
  selectionSchema,
  validateProjectConnection,
  projectConnectionDefinition,
} from "./contracts/connection-contract.mjs";
import { connectorContracts } from "./contracts/connector-contract-export.mjs";
import { object } from "./contracts/shape.mjs";
export const connectorRuntimes = {
  [runtimeContract]: {
    selectionSchema,
    executionSchema: object({ mode: { type: "string", enum: ["local"] } }),
    executionPlatforms: ["local"],
    prepareCommand: "connection prepare",
    contractsCommand: "connector contracts",
  },
};
export const definitions = [
  projectConnectionDefinition,
  {
    name: "connector contracts",
    description: "Export reviewed ODCS contracts",
    inputSchema: object({ review: { type: "object" } }),
  },
];
export function prepare(request) {
  const { runtimeAssets, ...input } = request;
  if (!runtimeAssets || !input.runtimeAssetSha256)
    throw Error("Install a source package with locked runtime assets");
  const selection = validateProjectConnection(input, {
    ...connectorRuntimes[runtimeContract],
    settingsSchema: JSON.parse(runtimeAssets["settings.schema.json"]),
  });
  if (
    ![input.sourceId, input.tenantId].every(
      (v) =>
        typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(v),
    )
  )
    throw Error("Explicit safe source and tenant identities required");
  if (
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 1 ||
    input.timeoutSeconds > 604800
  )
    throw Error("Explicit bounded timeout required");
  const connector = input.connector.split(":")[1];
  if (JSON.parse(runtimeAssets["runtime.lock.json"]).connector !== connector)
    throw Error("Runtime connector mismatch");
  const config = {
    apiVersion: "ingestron.singer/v1",
    mode: "customer-operated",
    connector,
    sourceId: input.sourceId,
    tenantId: input.tenantId,
    configEnv: "INGESTRON_TAP_CONFIG",
    timeoutSeconds: input.timeoutSeconds,
    reviewFile: "review.json",
    sourceSettings: input.settings,
    projectLock: input,
  };
  return {
    apiVersion: "ingestron.artifact-proposal/v1",
    applied: false,
    connector,
    execution: "local-posix-preview",
    artifacts: {
      ...runtimeAssets,
      "connector.json": JSON.stringify(config, null, 2),
      "selection.json": JSON.stringify(selection, null, 2),
      "project-connection.lock.json": JSON.stringify(input, null, 2),
    },
    review: [
      "Prepare a separate hash-locked Python 3.12 environment on POSIX.",
      "Discover, review and approve the selected ODCS projection before running.",
      "Retries reuse the run identity; a new snapshot needs a new identity.",
    ],
  };
}
export function command(request) {
  if (request.apiVersion !== "ingestron.provider-command-request/v1")
    throw Error("Unsupported command request");
  if (request.command === "project assemble") return assemble(request.input);
  if (request.command === "connection prepare") return prepare(request.input);
  if (request.command === "connector contracts")
    return connectorContracts(request.input);
  throw Error("Unsupported local provider command");
}
