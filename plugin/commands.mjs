// src/execution-source.mjs
var execution = `"""Explicit local execution adapter. No source implementation lives here."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import uuid


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    require(path.stat().st_size <= 10_000_000, 'Runtime metadata exceeds limit')
    return json.loads(path.read_text())


def write(path, data):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(data, sort_keys=True) + '\\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def inside(root, name):
    path = root / name
    require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'Unsafe runtime path')
    for part in [path, *path.parents]:
        if part == root.parent:
            break
        require(not part.is_symlink(), 'Runtime paths cannot cross symlinks')
    require(path.resolve().is_relative_to(root.resolve()), 'Runtime path leaves root')
    return path


@contextlib.contextmanager
def locked(path):
    require(not path.is_symlink(), 'Lock cannot be a symlink')
    with path.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Operation is already active; wait for completion')
        try:
            yield None
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def child(args, cwd, timeout=900, env=None):
    # Discard upstream errors: they can contain credentials or data.
    with subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          start_new_session=True) as process:
        try:
            output, _ = process.communicate(timeout=timeout)
            if process.returncode != 0:
                messages = {
                    'GITHUB_AUTH': 'GitHub rejected the supplied token. Check or replace it; no anonymous fallback was attempted.',
                    'GITHUB_FORBIDDEN': 'GitHub denied access. Check permissions or retry after any secondary rate limit.',
                    'GITHUB_NOT_FOUND': 'Repository not found or inaccessible. Check owner/name and permissions.',
                    'GITHUB_RATE_LIMIT': 'GitHub rate limit reached. Wait before retrying or configure an authorised token.',
                    'GITHUB_UNAVAILABLE': 'GitHub is temporarily unavailable. Retry later.',
                    'GITHUB_RESPONSE': 'GitHub returned an unsupported response or redirect. Check the repository name.',
                    'GITHUB_NETWORK': 'Cannot reach GitHub. Check network access and retry.',
                }
                try:
                    code = json.loads(output).get('errorCode') if len(output) <= 10000 else None
                except (ValueError, AttributeError):
                    code = None
                raise ValueError(messages.get(code, 'Runtime operation failed; check the locked environment, source access and review'))
            require(len(output) <= 10_000_000, 'Runtime response exceeds limit')
            return output.decode()
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGINT)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


def bootstrap(explicit):
    candidate = explicit or shutil.which('python3.12')
    if not candidate and sys.version_info[:2] == (3, 12):
        candidate = sys.executable
    if not candidate and shutil.which('uv'):
        try:
            candidate = child(['uv', 'python', 'find', '3.12', '--no-python-downloads'], Path.cwd(), 15).strip()
        except ValueError:
            pass
    require(candidate, 'Install Python 3.12, then repeat runtime prepare; --python is an optional override')
    candidate = os.path.abspath(candidate)
    version = child([candidate, '-I', '-c', 'import sys; print(".".join(map(str,sys.version_info[:3])))'], Path.cwd(), 15).strip()
    require(version.startswith('3.12.'), 'The locked connector runtime requires Python 3.12')
    return candidate, version


def clean_install_env():
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY') if k in os.environ}
    env.update({'PIP_CONFIG_FILE': os.devnull, 'PIP_DISABLE_PIP_VERSION_CHECK': '1', 'PYTHONNOUSERSITE': '1'})
    return env


def environment(root, info, cache, request, prepare=False):
    requirements = inside(root, info['requirements'])
    tools = inside(root, info['buildTools'])
    lock_key = digest(requirements.read_bytes() + b'\\0' + tools.read_bytes() + platform.platform().encode() + platform.machine().encode())
    folder = inside(cache, lock_key)
    marker = folder / 'ready.json'
    python = folder / 'bin/python'
    if prepare:
        with locked(cache / (lock_key + '.lock')):
            if marker.exists():
                require(load(marker)['lock'] == lock_key and python.exists(), 'Runtime cache is incomplete; remove its directory and prepare again')
                return str(python), lock_key, True
            executable, version = bootstrap(request.get('python'))
            if folder.exists():
                shutil.rmtree(folder)
            try:
                child([executable, '-I', '-m', 'venv', str(folder)], root)
                for lock in [tools, requirements]:
                    # Restrict installer input to exact package versions and hashes.
                    for line in lock.read_text().splitlines():
                        text = line.strip()
                        require(not text or text.startswith('#') or re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+(?:\\s*;[A-Za-z0-9_ .\\"\\'=!<>()-]+)?(?:\\s*\\\\)?', text) or re.fullmatch(r'--hash=sha256:[a-f0-9]{64}(?:\\s*\\\\)?', text), 'Unsupported dependency lock syntax')
                    child([str(python), '-I', '-m', 'pip', 'install', '--require-hashes', '--no-build-isolation', '--index-url', 'https://pypi.org/simple', '-r', str(lock)], root, 900, clean_install_env())
                write(marker, {'lock': lock_key, 'python': version})
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            return str(python), lock_key, False
    require(marker.exists() and python.exists() and load(marker)['lock'] == lock_key,
            'Runtime is not prepared. Run ingestron runtime prepare with the same --from and selection')
    return str(python), lock_key, True


def execute(request):
    require(request.get('apiVersion') == 'ingestron.execution-request/v1' and os.name == 'posix', 'Unsupported execution protocol/platform')
    root = Path(__file__).resolve().parent
    project = load(root / 'project-runtime.json')
    ids = request['flows']
    require(ids and len(ids) == len(set(ids)) and all(i in project['flows'] for i in ids), 'Unknown or duplicate flow selection')
    cache = Path(request['cache'])
    require(not cache.is_symlink(), 'Runtime cache cannot be a symlink')
    cache.mkdir(parents=True, exist_ok=True)
    action = request['action']
    require(action in ('prepare', 'discover', 'review', 'approve', 'run'), 'Unsupported local action')
    results = []
    for flow in ids:
        info = project['flows'][flow]
        folder = inside(root, info['directory'])
        runtime = project['environments'][info['runtime']]
        python, key, reused = environment(root, runtime, cache, request, action == 'prepare')
        if action == 'prepare':
            results.append({'flow': flow, 'environment': key, 'reused': reused,
                            'python': python, 'pythonVersion': load(cache / key / 'ready.json')['python']})
            continue
        # All flows are verified against their exact source-owned runtime before source access.
        child([python, '-c', 'import json,pathlib,singer_runtime as r; p=pathlib.Path.cwd(); r.runtime_identity(json.loads((p/"connector.json").read_text()),p)'], folder, 30)
        config = load(folder / 'connector.json')
        args = [python, str(folder / 'singer_runtime.py'), action, '--config', str(folder / 'connector.json')]
        if action == 'discover':
            args += ['--output', str(folder / 'discovery.json')]
        if action == 'review':
            args += ['--discovery', str(folder / 'discovery.json'), '--output', str(folder / 'review.json')]
        if action == 'run':
            args += ['--run-id', request['runId'], '--output', str(inside(root, 'data/' + flow))]
        with locked(folder / '.execution.lock'):
            output = child(args, folder, config.get('timeoutSeconds', 120) * 2 + 300)
        result = json.loads(output)
        results.append({'flow': flow, 'status': result.get('status'), 'tables': result.get('tables', [])})
    return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'succeeded', 'action': action, 'flows': results}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(2_000_001))
        response = execute(request)
    except KeyboardInterrupt:
        response = {'apiVersion': 'ingestron.execution-result/v1', 'status': 'interrupted', 'message': 'Execution interrupted; use the same run identity to retry'}
    except Exception as error:
        response = {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed', 'message': str(error) if isinstance(error, ValueError) else 'Local execution failed; check runtime preparation and reviewed inputs'}
    print(json.dumps(response))
    sys.exit(0 if response['status'] == 'succeeded' else 1)
`;

// src/project-runner.mjs
var runner = String.raw`"""Generated Ingestron project runner. Extraction remains owned by source packages."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent
    project = json.loads((root / 'project-runtime.json').read_text())
    parser = argparse.ArgumentParser(description='Run reviewed local project flows')
    parser.add_argument('action', choices=['list', 'discover', 'review', 'approve', 'run'])
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument('--flow')
    selection.add_argument('--all', action='store_true')
    parser.add_argument('--python', default=sys.executable, help='Preinstalled hash-locked Python 3.12 executable')
    parser.add_argument('--python-for', action='append', default=[], metavar='FLOW=PATH')
    parser.add_argument('--run-id')
    parser.add_argument('--output', default='data')
    args = parser.parse_args()
    if args.action == 'list':
        print('\n'.join(project['flows']))
        return
    if not args.flow and not args.all:
        parser.error('Select --flow or --all')
    if args.flow and args.flow not in project['flows']:
        parser.error('Unknown flow')
    if args.action == 'run' and not args.run_id:
        parser.error('Run requires --run-id; reuse it for a retry')
    interpreters = {}
    for item in args.python_for:
        flow, sep, path = item.partition('=')
        if not sep or flow not in project['flows'] or not path or flow in interpreters:
            parser.error('Use one --python-for FLOW=PATH for a declared flow')
        interpreters[flow] = str(Path(path).absolute())
    chosen = [args.flow] if args.flow else list(project['flows'])
    if any(not interpreters.get(flow, args.python) for flow in chosen):
        parser.error('Each selected flow needs --python or --python-for')
    for flow in chosen:
        info = project['flows'][flow]
        folder = (root / info['directory']).resolve()
        if not folder.is_relative_to(root):
            raise ValueError('Flow directory leaves package')
        python = str(Path(interpreters.get(flow, args.python)).absolute())
        command = [python, str(folder/'singer_runtime.py'), args.action, '--config', str(folder/'connector.json')]
        if args.action == 'discover': command += ['--output', str(folder/'discovery.json')]
        if args.action == 'review': command += ['--discovery', str(folder/'discovery.json'), '--output', str(folder/'review.json')]
        if args.action == 'run': command += ['--run-id', args.run_id, '--output', str((root/args.output/flow).resolve())]
        result = subprocess.run(command, cwd=folder, check=False)
        if result.returncode:
            raise SystemExit(result.returncode)
        print(flow + ': ' + args.action + ' succeeded')


if __name__ == '__main__':
    main()
`;

// src/project-assembly.mjs
var check = (v, m) => {
  if (!v) throw Error(m);
};
function assemble(input) {
  check(
    input.phase === "configure" || input.phase === "assemble",
    "Unknown project assembly phase"
  );
  if (input.phase === "configure") {
    check(
      input.execution.mode === "local",
      "Local provider requires local execution"
    );
    return { execution: input.execution };
  }
  check(
    !Object.keys(input.nativeFiles).length,
    "Local native standards are not implemented"
  );
  const artifacts = {}, flows = {}, environments = {};
  for (const c of input.connections) {
    check(
      /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(c.flow) && !flows[c.flow],
      "Invalid/duplicate flow"
    );
    for (const [name, content] of Object.entries(c.artifacts))
      artifacts[`flows/${c.flow}/${name}`] = content;
    const config = JSON.parse(c.artifacts["connector.json"]);
    const runtime = config.projectLock.runtimeAssetSha256;
    environments[runtime] = {
      requirements: `flows/${c.flow}/requirements.lock.txt`,
      buildTools: `flows/${c.flow}/build-tools.lock.txt`,
      source: config.projectLock.sourcePackage
    };
    flows[c.flow] = {
      directory: `flows/${c.flow}`,
      runtime,
      timeout: config.timeoutSeconds * 2 + 300
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
      environments
    },
    null,
    2
  );
  artifacts["README.md"] = "# Local project runner\n\nRun `python3 run.py list`. The normal route is ingestron runtime prepare, then ingestron run. For standalone execution, run.py defaults to its active interpreter; --python is an optional override. Run discover, review, inspect the generated review.json, then approve and run. Select --flow NAME or --all; run requires a stable --run-id. --python-for FLOW=PATH selects a different environment for a flow. Only explicit ingestron runtime prepare installs dependencies; building and running never install them.\n\nEach flow has an isolated reviewed runtime directory; identical dependency environments are inventoried once in project-runtime.json and may be reused. Output defaults to data/<flow>. Builds do not execute sources. Partial packages never remove other flows or their outputs.\n";
  return {
    apiVersion: "ingestron.project-package/v1",
    artifacts,
    details: {
      entryPoint: "run.py",
      flows: Object.keys(flows),
      dependencyEnvironments: Object.keys(environments),
      execution: "not-run",
      omissionMeansDeletion: false
    }
  };
}

// src/contracts/shape.mjs
var object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
var text = { type: "string", minLength: 1 };

// src/contracts/connection-contract.mjs
var runtimeContract = "ingestron.snapshot/python/v1";
var field = object(
  {
    type: {
      type: "string",
      enum: ["integer", "string", "boolean", "number", "decimal", "json"]
    },
    nullable: { type: "boolean" },
    precision: { type: "integer" },
    scale: { type: "integer" }
  },
  ["type", "nullable"]
);
var selectionSchema = {
  type: "object",
  additionalProperties: object({
    name: text,
    fields: { type: "object", additionalProperties: field }
  })
};
var projectConnectionDefinition = {
  name: "connection prepare",
  description: "Prepare a project-resolved connection, selected fields and runtime-only secrets",
  inputSchema: { type: "object", additionalProperties: true }
};
function validateProjectConnection(input, descriptor) {
  if (input.apiVersion !== "ingestron.connection-request/v1" || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*@\d+\.\d+\.\d+$/.test(input.connector) || input.runtimeContract !== runtimeContract || !input.specificationSha256)
    throw Error("Invalid project connection request");
  if (Object.keys(input).some(
    (k) => ![
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
      "execution",
      "timeoutSeconds",
      "sourcePackage",
      "executionPackage",
      "specificationSha256",
      "runtimeAssetSha256",
      "runtimeContract"
    ].includes(k)
  ))
    throw Error("Unknown project connection setting");
  if (input.tables && input.selection)
    throw Error("Use ODCS tables or legacy selection, never both");
  const selection = input.tables ? selectionFromTables(input.tables) : input.selection;
  if (!conforms(descriptor.settingsSchema, input.settings) || !conforms(descriptor.selectionSchema, selection) || !conforms(descriptor.executionSchema, input.execution))
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
      if (ref.env ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env) : !(/^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net$/.test(
        ref.vaultUrl
      ) && /^[A-Za-z0-9-]{1,127}$/.test(ref.name) && /^[a-fA-F0-9-]{36}$/.test(ref.identityClientId)))
        throw Error("Invalid runtime secret reference");
    }
  const names = Object.values(selection).map((table) => table.name);
  if (new Set(names).size !== names.length || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw Error("Invalid or duplicate selected table name");
  if (!Object.keys(selection).length)
    throw Error("Select at least one source stream");
  for (const [stream, table] of Object.entries(selection)) {
    if (!/^[A-Za-z0-9_-]+$/.test(stream) || !Object.keys(table.fields).length)
      throw Error("Select safe stream IDs and fields");
  }
  for (const table of Object.values(selection))
    for (const [name, field2] of Object.entries(table.fields)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw Error("Invalid selected field");
      if (field2.type === "decimal" ? !(Number.isInteger(field2.precision) && field2.precision >= 1 && field2.precision <= 38 && Number.isInteger(field2.scale) && field2.scale >= 0 && field2.scale <= field2.precision) : field2.precision !== void 0 || field2.scale !== void 0)
        throw Error("Invalid decimal precision/scale");
    }
  return selection;
}
function conforms(schema, value) {
  const allowed = /* @__PURE__ */ new Set([
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
    "maximum"
  ]);
  if (!schema || typeof schema !== "object" || Object.keys(schema).some((k) => !allowed.has(k)))
    throw Error("Unsupported connector schema keyword");
  if (schema.oneOf && schema.oneOf.filter((s) => conforms(s, value)).length !== 1)
    return false;
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)))
    return false;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const types = {
    object: isObject,
    array: Array.isArray(value),
    integer: Number.isInteger(value),
    number: typeof value === "number" && Number.isFinite(value),
    string: typeof value === "string",
    boolean: typeof value === "boolean",
    null: value === null
  };
  if (schema.type && !types[schema.type]) return false;
  if (typeof value === "number" && (schema.minimum !== void 0 && value < schema.minimum || schema.maximum !== void 0 && value > schema.maximum))
    return false;
  if (typeof value === "string" && (Array.from(value).length < (schema.minLength ?? 0) || Array.from(value).length > (schema.maxLength ?? Infinity)))
    return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || schema.items && !value.every((v) => conforms(schema.items, v))))
    return false;
  if (isObject) {
    if (!(schema.required ?? []).every((k) => Object.hasOwn(value, k)))
      return false;
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        if (!conforms(schema.properties[key], child)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (typeof schema.additionalProperties === "object" && !conforms(schema.additionalProperties, child))
        return false;
    }
  }
  return true;
}
function selectionFromTables(tables) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables))
    throw Error("Invalid ODCS table map");
  const selected = {};
  for (const [name, table] of Object.entries(tables)) {
    if (!table.contract || !Array.isArray(table.columns) || !table.columns.length || !table.source?.stream || selected[table.source.stream])
      throw Error("Invalid or duplicate contracted stream");
    const fields = {};
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
        BOOLEAN: "boolean"
      }[type];
      const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(type);
      if (!mapped && !decimal)
        throw Error(
          `Snapshot projection does not support ODCS physical type ${type}`
        );
      fields[column.name] = decimal ? {
        type: "decimal",
        precision: Number(decimal[1]),
        scale: Number(decimal[2]),
        nullable: !column.required
      } : { type: mapped, nullable: !column.required };
    }
    selected[table.source.stream] = { name, fields };
  }
  return selected;
}

// src/contracts/connector-contract-export.mjs
var check2 = (value, message) => {
  if (!value) throw Error(message);
};
var safe = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(v);
function connectorContracts(input) {
  check2(
    input && Object.keys(input).length === 1 && input.review?.apiVersion === "ingestron.singer-review/v1",
    "Supply one Singer review bundle"
  );
  check2(
    input.review.status === "approved",
    "Approve the reviewed projection first"
  );
  const entries = Object.entries(input.review.contracts ?? {});
  check2(entries.length >= 1 && entries.length <= 100, "Select 1\u2013100 contracts");
  const artifacts = {};
  for (const [name, contract] of entries) {
    check2(
      safe(name) && contract?.apiVersion === "v3.1.0" && typeof contract.id === "string",
      "Invalid ODCS contract identity"
    );
    artifacts[name + ".odcs.json"] = JSON.stringify(contract, null, 2);
  }
  return {
    apiVersion: "ingestron.artifact-proposal/v1",
    applied: false,
    artifacts,
    review: [
      "The host validates ODCS on export. The runtime independently checks agreement with the selected source projection.",
      "Source contracts require deliberate mappings before a common model or report pack can consume them."
    ]
  };
}

// src/commands.mjs
var connectorRuntimes = {
  [runtimeContract]: {
    selectionSchema,
    executionSchema: object({ mode: { type: "string", enum: ["local"] } }),
    executionPlatforms: ["local"],
    prepareCommand: "connection prepare",
    contractsCommand: "connector contracts"
  }
};
var definitions = [
  projectConnectionDefinition,
  {
    name: "connector contracts",
    description: "Export reviewed ODCS contracts",
    inputSchema: object({ review: { type: "object" } })
  }
];
function prepare(request) {
  const { runtimeAssets, ...input } = request;
  if (!runtimeAssets || !input.runtimeAssetSha256)
    throw Error("Install a source package with locked runtime assets");
  const selection = validateProjectConnection(input, {
    ...connectorRuntimes[runtimeContract],
    settingsSchema: JSON.parse(runtimeAssets["settings.schema.json"])
  });
  if (![input.sourceId, input.tenantId].every(
    (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(v)
  ))
    throw Error("Explicit safe source and tenant identities required");
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 604800)
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
    projectLock: input
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
      "project-connection.lock.json": JSON.stringify(input, null, 2)
    },
    review: [
      "Prepare a separate hash-locked Python 3.12 environment on POSIX.",
      "Discover, review and approve the selected ODCS projection before running.",
      "Retries reuse the run identity; a new snapshot needs a new identity."
    ]
  };
}
function command(request) {
  if (request.apiVersion !== "ingestron.provider-command-request/v1")
    throw Error("Unsupported command request");
  if (request.command === "project assemble") return assemble(request.input);
  if (request.command === "connection prepare") return prepare(request.input);
  if (request.command === "connector contracts")
    return connectorContracts(request.input);
  throw Error("Unsupported local provider command");
}
export {
  command,
  connectorRuntimes,
  definitions,
  prepare
};
