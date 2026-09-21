// src/lifecycle.mjs
function author(request) {
  if (request.apiVersion !== "ingestron.provider-authoring/v1" || request.operation !== "initialise")
    throw Error(
      "Local provider supports project initialisation; author ingestion flows with connections and ODCS tables"
    );
  const { id, environments = ["dev"] } = request.options;
  if (typeof id !== "string" || !Array.isArray(environments) || !environments.length || environments.some((e) => typeof e !== "string" || !/^\w[\w-]*$/.test(e)))
    throw Error("Invalid project/environment identifiers");
  const project = {
    apiVersion: "ingestron.project/v1",
    id,
    providers: {
      packages: { local: request.provider },
      configurations: { local: { package: "local", binding: "runtime" } }
    },
    defaults: { provider: "local" },
    environments: Object.fromEntries(
      environments.map((e) => [e, { $resolve: `environments/${e}.yaml` }])
    ),
    flows: []
  };
  const files = { "project.yaml": JSON.stringify(project, null, 2) };
  for (const environment of environments)
    files[`environments/${environment}.yaml`] = JSON.stringify(
      {
        apiVersion: "ingestron.environment/v1",
        environment,
        bindings: { runtime: { kind: "local" } },
        values: {}
      },
      null,
      2
    );
  return { files };
}
function validateOutput(request) {
  const files = request.files;
  if (!files["run.py"] || !files["project-runtime.json"])
    throw Error("Local project runner is missing");
  const project = JSON.parse(files["project-runtime.json"]);
  for (const flow of Object.values(project.flows)) {
    if (!files[flow.directory + "/connector.json"] || !files[flow.directory + "/singer_runtime.py"])
      throw Error("Local flow runtime is missing");
  }
  return { documents: [] };
}
export {
  author,
  validateOutput
};
