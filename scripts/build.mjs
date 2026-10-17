import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { stringify } from "yaml";
import { format } from "prettier";
writeFileSync(
  "src/execution-source.mjs",
  await format(
    "export const execution = " +
      JSON.stringify(readFileSync("src/execution.py", "utf8")) +
      ";\n",
    { parser: "babel" },
  ),
);
const { connectorRuntimes, definitions } = await import("../src/commands.mjs");
for (const name of ["commands", "lifecycle"])
  await build({
    entryPoints: [`src/${name}.mjs`],
    outfile: `plugin/${name}.mjs`,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
writeFileSync("plugin/execution.py", readFileSync("src/execution.py"));
writeFileSync(
  "plugin/source_access_host.py",
  readFileSync("src/source_access_host.py"),
);
const version = JSON.parse(readFileSync("package.json")).version;
const manifest = {
  apiVersion: "ingestron.provider/v1",
  id: "local",
  version,
  platform: "local",
  activities: {},
  compatibility: {
    plan: "ingestron.plan/v1",
    minimumCli: "4.2.0",
    requiredFeatures: [
      "connector-runtime-capabilities",
      "project-connections",
      "odcs-connections",
    ],
  },
  execution: {
    apiVersion: "ingestron.execution/v1",
    transport: "local-python/v1",
    entryPoint: "execute.py",
    actions: [
      "prepare",
      "catalogue",
      "discover",
      "review",
      "approve",
      "run",
      "checkpoint_preview",
      "checkpoint_apply",
    ],
    status: "receipt",
    retry: "same-run-id",
    cancellation: "interrupt",
    acknowledgement: "provider-journal/v1",
    resources: {
      apiVersion: "ingestron.execution-resources/v1",
      command: "execution resources",
    },
  },
  sourceAccess: {
    apiVersion: "ingestron.source-access-host/v1",
    transport: "local-python/v1",
    entryPoint: "source_access_host.py",
  },
  connectorRuntimes,
  lifecycle: {
    apiVersion: "ingestron.provider-lifecycle/v1",
    module: "./lifecycle.mjs",
  },
  commands: {
    apiVersion: "ingestron.provider-commands/v1",
    execution: "offline-json",
    module: "./commands.mjs",
    definitions,
  },
};

manifest.projectAssembly = {
  apiVersion: "ingestron.project-assembly/v1",
  command: "project assemble",
  metadataDocuments: "ingestron.metadata-documents/v1",
};
manifest.compatibility.requiredFeatures = [
  ...new Set([
    ...manifest.compatibility.requiredFeatures,
    "project-assembly",
    "connection-metadata-documents",
    "provider-execution",
    "source-checkpoint-migration",
    "provider-execution-resources",
    "provider-execution-acknowledgement",
    "connector-schedule-handover",
    "portable-scheduler",
  ]),
];
manifest.commands.definitions = manifest.commands.definitions.filter(
  (d) => d.name !== "project assemble",
);
manifest.commands.definitions.push({
  name: "project assemble",
  description: "Assemble one scoped platform project without deployment",
  inputSchema: { type: "object", additionalProperties: true },
});
writeFileSync(
  "plugin/provider.yaml",
  await format(stringify(manifest), { parser: "yaml" }),
);
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== version
)
  throw Error("Release tag differs from provider version");
