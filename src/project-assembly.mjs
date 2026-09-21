import { execution } from "./execution-source.mjs";
import { runner } from "./project-runner.mjs";
const check = (v, m) => {
  if (!v) throw Error(m);
};
export function assemble(input) {
  check(
    input.phase === "configure" || input.phase === "assemble",
    "Unknown project assembly phase",
  );
  if (input.phase === "configure") {
    check(
      input.execution.mode === "local",
      "Local provider requires local execution",
    );
    return { execution: input.execution };
  }
  check(
    !Object.keys(input.nativeFiles).length,
    "Local native standards are not implemented",
  );
  const artifacts = {},
    flows = {},
    environments = {};
  for (const c of input.connections) {
    check(
      /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(c.flow) && !flows[c.flow],
      "Invalid/duplicate flow",
    );
    for (const [name, content] of Object.entries(c.artifacts))
      artifacts[`flows/${c.flow}/${name}`] = content;
    const config = JSON.parse(c.artifacts["connector.json"]);
    const runtime = config.projectLock.runtimeAssetSha256;
    environments[runtime] = {
      requirements: `flows/${c.flow}/requirements.lock.txt`,
      buildTools: `flows/${c.flow}/build-tools.lock.txt`,
      source: config.projectLock.sourcePackage,
    };
    flows[c.flow] = {
      directory: `flows/${c.flow}`,
      runtime,
      timeout: config.timeoutSeconds * 2 + 300,
    };
  }
  artifacts["run.py"] = runner;
  artifacts["execute.py"] = execution;
  artifacts["project-runtime.json"] = JSON.stringify(
    {
      project: input.project,
      environment: input.environment,
      configuration: input.configuration,
      scope: input.scope,
      flows,
      environments,
    },
    null,
    2,
  );
  artifacts["README.md"] =
    "# Local project runner\n\nRun `python3 run.py list`. The normal route is ingestron runtime prepare, then ingestron run. For standalone execution, run.py defaults to its active interpreter; --python is an optional override. Run discover, review, inspect the generated review.json, then approve and run. Select --flow NAME or --all; run requires a stable --run-id. --python-for FLOW=PATH selects a different environment for a flow. Only explicit ingestron runtime prepare installs dependencies; building and running never install them.\n\nEach flow has an isolated reviewed runtime directory; identical dependency environments are inventoried once in project-runtime.json and may be reused. Output defaults to data/<flow>. Builds do not execute sources. Partial packages never remove other flows or their outputs.\n";
  return {
    apiVersion: "ingestron.project-package/v1",
    artifacts,
    details: {
      entryPoint: "run.py",
      flows: Object.keys(flows),
      dependencyEnvironments: Object.keys(environments),
      execution: "not-run",
      omissionMeansDeletion: false,
    },
  };
}
