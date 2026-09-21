/** Build an independent, test-only source package. It is not part of plugin/. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { stringify } from "yaml";
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function syntheticSource(root) {
  mkdirSync(root, { recursive: true });
  const settings = {
    type: "object",
    properties: { count: { type: "integer", minimum: 1, maximum: 100 } },
    required: ["count"],
    additionalProperties: false,
  };
  const assets = {
    "singer_runtime.py": readFileSync(
      new URL("../test/fixtures/synthetic_runtime.py", import.meta.url),
      "utf8",
    ),
    "settings.schema.json": JSON.stringify(settings),
    "requirements.lock.txt":
      "# Test source uses only the Python standard library.\n",
    "build-tools.lock.txt": "# No build tools required.\n",
  };
  assets["runtime.lock.json"] = JSON.stringify({
    connector: "synthetic@1.0.0",
    files: Object.fromEntries(
      Object.entries(assets).map(([name, content]) => [name, digest(content)]),
    ),
  });
  const runtime = JSON.stringify(assets);
  writeFileSync(resolve(root, "runtime.json"), runtime);
  writeFileSync(
    resolve(root, "LICENSE"),
    readFileSync(new URL("../LICENSE", import.meta.url)),
  );
  writeFileSync(
    resolve(root, "connector.yaml"),
    stringify({
      apiVersion: "ingestron.connector/v1",
      id: "synthetic",
      version: "1.0.0",
      description: "Test-only JSON source for provider compatibility checks",
      connector: "example:synthetic@1.0.0",
      documentation: "https://github.com/ingestron/provider-local",
      upstream: {
        ecosystem: "example",
        variant: "synthetic",
        package: "synthetic",
        version: "1.0.0",
        repository: "https://github.com/ingestron/provider-local",
        licence: "Apache-2.0",
        licenceFile: "LICENSE",
        licenceStatus: "evidenced",
      },
      runtime: {
        path: "runtime.json",
        sha256: digest(runtime),
        contract: "ingestron.snapshot/python/v1",
      },
      definition: {
        settingsSchema: settings,
        selectionSchema: { type: "object", additionalProperties: true },
      },
      execution: {
        local: { modes: ["local"], evidence: "Synthetic JSON fixture only" },
      },
    }),
  );
}
