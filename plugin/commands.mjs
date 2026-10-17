// src/execution-source.mjs
var execution = `"""Explicit local execution adapter. No source implementation lives here."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import math
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


def quality_message(failed):
    # Contract rule identities and counts only; never row values.
    rules = []
    for rule in failed if isinstance(failed, list) else []:
        if not isinstance(rule, dict): continue
        name = re.sub(r'[^A-Za-z0-9_.:-]', '_', str(rule.get('id', 'rule')))[:80]
        value = rule.get('value')
        rules.append(name + (f' ({value})' if isinstance(value, (int, float)) and not isinstance(value, bool) else ''))
    listed = ', '.join(rules[:10]) or 'unreported rules'
    return ('Contract quality rules failed; nothing was committed: ' + listed +
            '. Fix the source data or review the rule severity, then retry with the same run ID.')


class SourceFailure(ValueError):
    def __init__(self,code,message):
        self.code=code
        super().__init__(message)


class QualityFailure(ValueError):
    def __init__(self, failed):
        self.quality = []
        for rule in failed[:20] if isinstance(failed, list) else []:
            if not isinstance(rule, dict):
                continue
            value = rule.get('value')
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                continue
            if rule.get('metric') not in ('nullValues', 'missingValues', 'invalidValues', 'duplicateValues', 'rowCount'):
                continue
            if any(not isinstance(rule.get(k), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', rule[k]) for k in ('id', 'stream')):
                continue
            self.quality.append({k: rule[k] for k in ('id', 'stream', 'metric', 'value')})
        super().__init__(quality_message(self.quality))


def child(args, cwd, timeout=900, env=None):
    # Discard upstream errors: they can contain credentials or data.
    with subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          start_new_session=True) as process:
        try:
            output, _ = process.communicate(timeout=timeout)
            if process.returncode != 0:
                messages = {
                    'SOURCE_METADATA_COLLECTION_LIMIT': 'This flow exceeds the 7 MB metadata collection limit. Split tables into smaller flows or select fewer fields, then prepare again.',
                    'SOURCE_METADATA_LIMIT': 'This flow exceeds the 2 MB metadata limit. Split tables into smaller flows or select fewer fields, then prepare again.',
                    'SQL_CONNECT': 'Cannot connect to SQL. Check network access, credentials and TLS. If the database was paused, wait for it to resume before retrying.',
                    'SQL_READ': 'SQL read failed. Check table permissions and source availability.',
                    'SQL_TABLE': 'SQL table is absent or its metadata is not visible. Check schema, table and metadata permissions.',
                    'DB_CONNECT': 'Cannot connect to the database. Check host, port, network access, credentials and TLS.',
                    'DB_READ': 'Database read failed. Check table permissions and source availability.',
                    'DB_TABLE': 'Database table is absent or its metadata is not visible. Check schema, table and permissions.',
                    'TEMPORAL_DATE': 'DATE requires a valid calendar date in YYYY-MM-DD format; review the source field or contract mapping.',
                    'TEMPORAL_TIMESTAMP': 'TIMESTAMP requires a valid full calendar date and time; review the source field or contract mapping.',
                    'TEMPORAL_TIMEZONE': 'TIMESTAMP requires a timezone-less value; review an explicit timezone mapping before ingestion.',
                    'TEMPORAL_PRECISION': 'Source timestamp precision exceeds six fractional digits; review an exact precision mapping before ingestion.',
                    'TEMPORAL_TYPE': 'Select a supported reviewed temporal type.',
                    'CHECKPOINT_HISTORY': 'Incremental commit history is incomplete or changed. Restore the committed output and receipts before retrying.',
                    'CHECKPOINT_MIGRATION': 'The reviewed checkpoint transition is absent, changed or belongs to another history. Inspect the retained build and review again.',
                    'CHECKPOINT_MIGRATION_STALE': 'The committed checkpoint head changed after review. Preview the current migration before applying.',
                    'CHECKPOINT_POLICY': 'The incremental source, schema or policy changed. Review a migration before continuing this output namespace.',
                    'CHECKPOINT_LIMIT': 'Incremental history reached 10000 batches. Review an archive migration before continuing.',
                    'CHECKPOINT_CURSOR': 'The connector returned an invalid or regressing cursor. Check the reviewed ordered append policy before retrying.',
                    'CHECKPOINT_MISSING': 'The connector omitted its final checkpoint. Output and cursor were not committed.',
                    'OUTPUT_BUSY': 'Another run is writing this output namespace. Retry after that run finishes.',

                    'GITHUB_AUTH': 'GitHub rejected the supplied token. Check or replace it; no anonymous fallback was attempted.',
                    'GITHUB_FORBIDDEN': 'GitHub denied access. Check permissions or retry after any secondary rate limit.',
                    'GITHUB_NOT_FOUND': 'Repository not found or inaccessible. Check owner/name and permissions.',
                    'GITHUB_RATE_LIMIT': 'GitHub rate limit reached. Wait before retrying or configure an authorised token.',
                    'GITHUB_UNAVAILABLE': 'GitHub is temporarily unavailable. Retry later.',
                    'GITHUB_RESPONSE': 'GitHub returned an unsupported response or redirect. Check the repository name.',
                    'GITHUB_NETWORK': 'Cannot reach GitHub. Check network access and retry.',
                }
                try:
                    failure = json.loads(output) if len(output) <= 10000 else {}
                    code = failure.get('errorCode')
                except (ValueError, AttributeError):
                    failure, code = {}, None
                if code == 'QUALITY_FAILED':
                    raise QualityFailure(failure.get('failed'))
                if code in messages:
                    if code.startswith(('TEMPORAL_', 'CHECKPOINT_')) or code in ('OUTPUT_BUSY', 'SOURCE_METADATA_LIMIT', 'SOURCE_METADATA_COLLECTION_LIMIT'):raise SourceFailure(code,messages[code])
                    raise ValueError(messages[code])
                # Other connectors' codes are named, never their messages; each
                # connector's documentation explains its codes.
                if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{2,40}', code):
                    raise ValueError(f'Source error {code}; see the connector documentation for this code')
                raise ValueError('Runtime operation failed; check the locked environment, source access and review')
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


def verify_runtime_identity(python, folder):
    # Preserve only known safe metadata codes from the source-owned preflight.
    # Older source runtimes need no new imports; other errors stay private.
    script = '''import json,pathlib,singer_runtime as r
p=pathlib.Path.cwd()
try:
    r.runtime_identity(json.loads((p/"connector.json").read_text()),p)
except ValueError as error:
    code=getattr(error,"code",None)
    if code not in ("SOURCE_METADATA_LIMIT","SOURCE_METADATA_COLLECTION_LIMIT"):
        raise
    print(json.dumps({"errorCode":code}))
    raise SystemExit(1)
'''
    child([python, '-c', script], folder, 30)


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
    require(action in ('prepare', 'catalogue', 'discover', 'review', 'approve', 'run', 'checkpoint_preview', 'checkpoint_apply'), 'Unsupported local action')
    maintenance = action in ('checkpoint_preview', 'checkpoint_apply')
    require(not maintenance or len(ids) == 1, 'Checkpoint maintenance requires one flow')
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
        if maintenance:
            declaration = info.get('checkpointMigration')
            require(declaration == {'apiVersion': 'ingestron.checkpoint-migration/v1', 'strategy': 'preserve-cursor-runtime-upgrade'}, 'Upgrade the selected source package to support reviewed checkpoint migration')
            project_root, prior_root = Path(request.get('projectRoot', '')), Path(request.get('previousRoot', ''))
            require(project_root.is_absolute() and prior_root.is_absolute() and root.resolve().is_relative_to(project_root.resolve()) and prior_root.resolve().is_relative_to(project_root.resolve()), 'Checkpoint baseline must remain in the selected project')
            # Validate all path components, including the retained package root.
            prior_root = inside(project_root, str(prior_root.relative_to(project_root)))
            prior = load(inside(prior_root, 'project-runtime.json'))
            require(all(prior.get(key) == project.get(key) for key in ('project', 'environment', 'configuration')) and flow in prior.get('flows', {}), 'Checkpoint baseline has another project or flow scope')
            previous_folder = inside(prior_root, prior['flows'][flow]['directory'])
            args = [python, '-B', str(inside(folder, 'singer_runtime.py')), action, '--config', str(inside(folder, 'connector.json')), '--previous-config', str(inside(previous_folder, 'connector.json')), '--output', str(inside(root, 'data/' + flow))]
            if action == 'checkpoint_apply':
                require(isinstance(request.get('expectedDigest'), str) and re.fullmatch(r'[a-f0-9]{64}', request['expectedDigest']), 'Review the exact checkpoint migration digest before apply')
                args += ['--expected-digest', request['expectedDigest']]
            with locked(folder / '.execution.lock'):
                result = json.loads(child(args, folder, 300))
            require(set(result) == {'status', 'migration'} and result['status'] == 'Succeeded', 'Invalid source checkpoint response')
            results.append({'flow': flow, 'status': 'Succeeded', 'migration': result['migration']})
            continue
        # All flows are verified against their exact source-owned runtime before source access.
        verify_runtime_identity(python, folder)
        config = load(folder / 'connector.json')
        args = [python, str(folder / 'singer_runtime.py'), action, '--config', str(folder / 'connector.json')]
        staged = folder / ('.' + action + '.' + uuid.uuid4().hex + '.tmp') if action in ('catalogue', 'discover', 'review') else None
        if action in ('catalogue', 'discover'):
            args += ['--output', str(staged)]
        if action == 'review':
            args += ['--discovery', str(folder / 'discovery.json'), '--output', str(staged)]
        if action == 'run':
            args += ['--run-id', request['runId'], '--output', str(inside(root, 'data/' + flow))]
        with locked(folder / '.execution.lock'):
            try:
                output = child(args, folder, config.get('timeoutSeconds', 120) * 2 + 300)
                if staged is not None:
                    history = folder / 'history'
                    require(not history.is_symlink(), 'Evidence history cannot be a symlink')
                    history.mkdir(exist_ok=True)
                    names = {'catalogue': ('catalogue.json',), 'discover': ('discovery.json', 'review.json'),
                             'review': ('review.json',)}[action]
                    for name in names:
                        previous = folder / name
                        require(not previous.is_symlink(), 'Evidence cannot be a symlink')
                        if previous.exists():
                            shutil.copy2(previous, history / (name[:-5] + '-' + uuid.uuid4().hex + '.json'))
                    staged.replace(folder / names[0])
                    if action == 'discover':
                        (folder / 'review.json').unlink(missing_ok=True)
            finally:
                if staged is not None: staged.unlink(missing_ok=True)
        result = json.loads(output)
        if action == 'catalogue':
            # Field names and types only; the full catalogue stays in the flow folder.
            catalogue = load(folder / 'catalogue.json')
            results.append({'flow': flow, 'status': result.get('status'),
                            'catalogue': str((folder / 'catalogue.json').relative_to(root)),
                            'tables': {t: len(v.get('columns', [])) for t, v in catalogue.get('tables', {}).items()}})
            continue
        checkpoint = result.get('checkpoint')
        if checkpoint is not None:
            require(isinstance(checkpoint, dict) and set(checkpoint) == {'sequence', 'bookmarks', 'hasMore'}
                    and type(checkpoint['sequence']) is int and 1 <= checkpoint['sequence'] <= 10000
                    and type(checkpoint['hasMore']) is bool and isinstance(checkpoint['bookmarks'], dict)
                    and 1 <= len(checkpoint['bookmarks']) <= 100,
                    'Invalid incremental checkpoint result')
            for name, value in checkpoint['bookmarks'].items():
                require(isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,100}', name)
                        and isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]{0,18}', value)
                        and int(value) <= 9223372036854775807, 'Invalid incremental cursor result')
        results.append({'flow': flow, 'status': result.get('status'), 'tables': result.get('tables', []),
                        **({'quality': result['quality']} if isinstance(result.get('quality'), list) else {}),
                        **({'checkpoint': checkpoint} if checkpoint is not None else {})})
    return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'succeeded', 'action': action, 'flows': results}


CHECKPOINT_FAILURES = ('CHECKPOINT_MIGRATION', 'CHECKPOINT_MIGRATION_STALE', 'CHECKPOINT_POLICY', 'CHECKPOINT_HISTORY', 'CHECKPOINT_LIMIT', 'CHECKPOINT_CURSOR', 'CHECKPOINT_MISSING', 'OUTPUT_BUSY')
EXECUTION_FAILURES = (*CHECKPOINT_FAILURES, 'SOURCE_METADATA_LIMIT', 'SOURCE_METADATA_COLLECTION_LIMIT')

SETUP_ACTIONS = ('prepare', 'catalogue', 'discover', 'review', 'approve', 'checkpoint_preview', 'checkpoint_apply')


class OperationUncertain(ValueError):
    """No durable provider acknowledgement exists; never claim a known failure."""


def operation_location(request):
    action = request.get('originalAction') if request.get('action') == 'acknowledge' else request.get('action')
    require(action in SETUP_ACTIONS, 'Only setup actions use this acknowledgement protocol')
    run_id, fingerprint, flows = request.get('runId'), request.get('fingerprint'), request.get('flows')
    require(isinstance(run_id, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', run_id), 'Invalid original operation identity')
    require(isinstance(fingerprint, str) and re.fullmatch(r'[a-f0-9]{64}', fingerprint), 'Invalid operation build fingerprint')
    require(isinstance(flows, list) and 1 <= len(flows) <= 100 and len(flows) == len(set(flows))
            and all(isinstance(flow, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', flow) for flow in flows), 'Invalid original flow selection')
    cache = Path(request['cache'])
    require(cache.is_absolute() and not cache.is_symlink(), 'Invalid operation cache')
    cache.mkdir(parents=True, exist_ok=True)
    area = inside(cache, '.ingestron-operation-receipts')
    area.mkdir(mode=0o700, exist_ok=True)
    namespace = inside(cache, '.ingestron-operation-receipts/' + fingerprint)
    namespace.mkdir(mode=0o700, exist_ok=True)
    folder = inside(namespace, run_id)
    binding = {'apiVersion': 'ingestron.execution-operation/v1', 'id': run_id,
               'action': action, 'flows': flows, 'fingerprint': fingerprint}
    return folder, binding


def journal_read(folder, name):
    path = inside(folder, name)
    require(path.is_file() and not path.is_symlink(), 'Invalid operation acknowledgement file')
    return load(path)


def operation_acknowledgement(request):
    folder, binding = operation_location(request)
    if not folder.exists() or not (folder / 'acknowledgement.json').exists():
        raise OperationUncertain('Original operation has no durable acknowledgement; retain its build ownership')
    ack = journal_read(folder, 'acknowledgement.json')
    expected = {'apiVersion': 'ingestron.execution-acknowledgement/v1', **{k: binding[k] for k in ('id', 'action', 'flows', 'fingerprint')}}
    require(isinstance(ack, dict) and set(ack) == {*expected, 'result'} and all(ack[k] == v for k, v in expected.items()), 'Original operation acknowledgement does not match its binding')
    result = ack['result']
    require(isinstance(result, dict) and {'apiVersion', 'status', 'action', 'flows'} <= set(result) <= {'apiVersion', 'status', 'action', 'flows', 'errorCode'}
            and result['apiVersion'] == 'ingestron.execution-result/v1' and result['action'] == binding['action']
            and result['status'] in ('succeeded', 'failed') and isinstance(result['flows'], list)
            and len(result['flows']) <= 100, 'Invalid original operation result')
    require('errorCode' not in result or (result['status'] == 'failed' and result['errorCode'] in EXECUTION_FAILURES), 'Invalid execution failure evidence')
    require(result['status'] == 'failed' or [flow.get('flow') for flow in result['flows']] == binding['flows'], 'Original operation result has another selection')
    return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'succeeded', 'acknowledgement': ack}


def operation_response(request):
    try:
        return execute(request)
    except KeyboardInterrupt:
        return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'interrupted'}
    except QualityFailure as error:
        return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed', 'errorCode': 'QUALITY_FAILED', 'quality': error.quality, 'message': str(error)}
    except SourceFailure as error:
        return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed', 'errorCode': error.code, 'message': str(error)}
    except Exception as error:
        return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed', 'message': str(error) if isinstance(error, ValueError) else 'Local execution failed; check runtime preparation and reviewed inputs'}


def operation_worker(request):
    # This independently grouped finaliser survives the original adapter parent.
    # It records evidence only after execute has finished all owned child work.
    folder, binding = operation_location(request)
    submission = journal_read(folder, 'submission.json')
    require(submission == {'binding': binding, 'nonce': request.get('operationNonce')}, 'Operation worker does not own this submission')
    with locked(inside(folder, 'worker.lock')):
        require(not (folder / 'acknowledgement.json').exists(), 'Original operation already finalised')
        write(inside(folder, 'worker.json'), {'pid': os.getpid(), 'nonce': submission['nonce']})
        result = operation_response(request)
        acknowledgement = {'apiVersion': 'ingestron.execution-acknowledgement/v1',
                           **{k: binding[k] for k in ('id', 'action', 'flows', 'fingerprint')},
                           'result': {'apiVersion': 'ingestron.execution-result/v1',
                                      'status': 'succeeded' if result['status'] == 'succeeded' else 'failed',
                                      'action': binding['action'], 'flows': result.get('flows', []),
                                      **({'errorCode': result['errorCode']} if result.get('status') == 'failed' and result.get('errorCode') in EXECUTION_FAILURES else {})}}
        # No executable operation or source write follows this atomic commit.
        write(inside(folder, 'acknowledgement.json'), acknowledgement)
        return result


def operation_dispatch(request):
    require(request.get('apiVersion') == 'ingestron.execution-request/v1', 'Unsupported execution protocol')
    if request.get('action') == 'acknowledge':
        return operation_acknowledgement(request)
    if request.get('action') not in SETUP_ACTIONS:
        return operation_response(request)
    folder, binding = operation_location(request)
    try:
        require(sum(1 for _ in folder.parent.iterdir()) < 10000, 'Review an operation receipt archive before starting more setup work')
        folder.mkdir(mode=0o700)
    except FileExistsError:
        submission = journal_read(folder, 'submission.json')
        require(submission.get('binding') == binding, 'Original identity belongs to another operation')
        return operation_acknowledgement(request)['acknowledgement']['result']
    nonce = uuid.uuid4().hex
    write(inside(folder, 'submission.json'), {'binding': binding, 'nonce': nonce})
    worker_request = {**request, 'operationNonce': nonce}
    with subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--operation-worker'],
                          stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          start_new_session=True) as worker:
        worker.communicate(json.dumps(worker_request).encode())
    # Child absence, a failed exit, or elapsed time is not an acknowledgement.
    return operation_acknowledgement(request)['acknowledgement']['result']


if __name__ == '__main__':
    try:
        payload = sys.stdin.read(2_000_001)
        require(len(payload) <= 2_000_000, 'Execution request exceeds limit')
        request = json.loads(payload)
        if sys.argv[1:] == ['--operation-worker']:
            def interrupt_worker(_signal, _frame):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, interrupt_worker)
        response = operation_worker(request) if sys.argv[1:] == ['--operation-worker'] else operation_dispatch(request)
    except (KeyboardInterrupt, OperationUncertain):
        response = {'apiVersion': 'ingestron.execution-result/v1', 'status': 'interrupted', 'message': 'Original operation outcome is unconfirmed; inspect its durable acknowledgement'}
    except Exception:
        # Failure to read or write acknowledgement metadata cannot prove that an
        # already dispatched worker stopped. Retain source uncertainty.
        response = {'apiVersion': 'ingestron.execution-result/v1', 'status': 'interrupted', 'message': 'Operation acknowledgement is unavailable; retain the original identity'}
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
  const artifacts = {}, flows = {}, environments = {}, metadataDocumentRoots = {};
  for (const c of input.connections) {
    check(
      /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(c.flow) && !flows[c.flow],
      "Invalid/duplicate flow"
    );
    for (const [name, content] of Object.entries(c.artifacts))
      artifacts[`flows/${c.flow}/${name}`] = content;
    const config = JSON.parse(c.artifacts["connector.json"]);
    if (c.metadataDocuments) {
      check(
        c.metadataDocuments.apiVersion === "ingestron.metadata-documents/v1" && JSON.stringify(c.metadataDocuments) === JSON.stringify(config.projectLock.tableDocuments) && !Object.keys(c.artifacts).some(
          (name) => name.startsWith("metadata/project/")
        ),
        "Indexed assembly requires the original index and external documents"
      );
      metadataDocumentRoots[c.flow] = `flows/${c.flow}`;
    }
    const runtime = config.projectLock.runtimeAssetSha256;
    environments[runtime] = {
      requirements: `flows/${c.flow}/requirements.lock.txt`,
      buildTools: `flows/${c.flow}/build-tools.lock.txt`,
      source: config.projectLock.sourcePackage
    };
    const checkpointMigration = c.artifacts["runtime.lock.json"] ? JSON.parse(c.artifacts["runtime.lock.json"]).checkpointMigration : void 0;
    flows[c.flow] = {
      directory: `flows/${c.flow}`,
      runtime,
      timeout: config.timeoutSeconds * 2 + 300,
      ...checkpointMigration ? { checkpointMigration } : {}
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
    metadataDocumentRoots,
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

// src/contracts/metadata-projection.mjs
function validateMetadataProjection(input, tables) {
  const index = input.tableDocuments;
  const object2 = (value) => value && typeof value === "object" && !Array.isArray(value);
  const keys = (value, expected) => object2(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
  if (Object.hasOwn(input, "tables") || Object.hasOwn(input, "selection") || !keys(index, ["apiVersion", "kind", "documents", "totalBytes"]) || index.apiVersion !== "ingestron.metadata-documents/v1" || index.kind !== "project" || !object2(index.documents) || !object2(tables))
    throw Error("Invalid indexed connection metadata");
  const names = Object.keys(index.documents);
  if (!names.length || names.length > 100 || Object.keys(tables).length !== names.length)
    throw Error("Invalid indexed connection metadata");
  let bytes = 0;
  for (const name of names) {
    const record = index.documents[name], table = tables[name];
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(name) || !Object.hasOwn(tables, name) || !keys(record, ["path", "sha256", "bytes"]) || !/^[a-f0-9]{64}$/.test(record.sha256) || record.path !== `metadata/project/${record.sha256}.json` || !Number.isInteger(record.bytes) || record.bytes < 1 || record.bytes > 2e6 || !object2(table) || Object.keys(table).some(
      (key) => !["source", "columns", "contract"].includes(key)
    ) || !object2(table.source) || !Array.isArray(table.columns) || table.columns.length > 500 || (Object.hasOwn(table, "contract") ? table.contract !== true || !table.columns.length : table.columns.length !== 0))
      throw Error("Invalid indexed connection metadata");
    bytes += record.bytes;
  }
  if (bytes > 7e6 || index.totalBytes !== bytes)
    throw Error("Indexed metadata exceeds its collection bounds");
}

// src/contracts/connection-contract.mjs
var runtimeContract = "ingestron.snapshot/python/v1";
var field = object(
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
        "timestamp"
      ]
    },
    nullable: { type: "boolean" },
    target: { type: "string", minLength: 1 },
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
function validateProjectConnection(input, descriptor, projectionTables) {
  if (Object.hasOwn(input, "tableDocuments"))
    validateMetadataProjection(input, projectionTables);
  else if (projectionTables !== void 0)
    throw Error("Projection requires indexed connection metadata");
  const tables = projectionTables ?? input.tables;
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
      "tableDocuments",
      "execution",
      "timeoutSeconds",
      "sourcePackage",
      "executionPackage",
      "specificationSha256",
      "runtimeAssetSha256",
      "runtimeContract",
      "schedule"
    ].includes(k)
  ))
    throw Error("Unknown project connection setting");
  if (Object.hasOwn(input, "schedule")) {
    const schedule = input.schedule;
    const keys = [
      "apiVersion",
      "owner",
      "clock",
      "definition",
      "boundaries",
      "digest"
    ];
    const ownerKeys = ["project", "environment", "flow", "connection"];
    const object2 = (value) => value && typeof value === "object" && !Array.isArray(value);
    if (!object2(schedule) || Object.keys(schedule).length !== keys.length || !keys.every((key) => Object.hasOwn(schedule, key)) || schedule.apiVersion !== descriptor.scheduling?.apiVersion || schedule.clock !== "portable" || descriptor.scheduling?.clock !== "portable" || !object2(schedule.owner) || Object.keys(schedule.owner).length !== ownerKeys.length || !ownerKeys.every(
      (key) => typeof input[key] === "string" && input[key].length > 0 && schedule.owner[key] === input[key]
    ) || !object2(schedule.definition) || schedule.definition.apiVersion !== "ingestron.schedule/v1" || !descriptor.scheduling.recurrences.includes(
      schedule.definition.recurrence?.kind
    ) || !["skip", "queue"].includes(schedule.definition.overlap) || !["skip", "latest"].includes(schedule.definition.missed) || !object2(schedule.boundaries) || schedule.boundaries.apiVersion !== "ingestron.schedule-boundaries/v1" || schedule.boundaries.timeZone !== schedule.definition.timeZone || !/^[a-f0-9]{64}$/.test(schedule.digest) || !/^[a-f0-9]{64}$/.test(input.specificationSha256))
      throw Error(
        "Local execution requires a scope-bound reviewed portable schedule"
      );
  }
  if (input.tables && input.selection)
    throw Error("Use ODCS tables or legacy selection, never both");
  const incremental = input.execution?.ingestion === "incremental";
  if (incremental && !tables)
    throw Error(
      "Incremental append execution requires reviewed table policies"
    );
  for (const table of Object.values(tables ?? {}))
    if (!!table.source?.incremental !== incremental)
      throw Error(
        "Use an incremental policy on every table only in incremental execution"
      );
  const selection = tables ? selectionFromTables(tables) : input.selection;
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
  const discoveryOnly = tables && Object.values(tables).every((t) => !t.contract);
  if (!Object.keys(selection).length && !discoveryOnly)
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
  for (const table of Object.values(selection)) {
    const targets = Object.entries(table.fields).map(
      ([source, field2]) => field2.target ?? source
    );
    if (new Set(targets).size !== targets.length || targets.some((target) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)))
      throw Error("Invalid or duplicate target field");
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
  const streams = /* @__PURE__ */ new Set();
  for (const [name, table] of Object.entries(tables)) {
    if (!table.source?.stream || streams.has(table.source.stream))
      throw Error("Invalid or duplicate contracted stream");
    streams.add(table.source.stream);
    if (!table.contract && Array.isArray(table.columns) && !table.columns.length)
      continue;
    if (!table.contract || !Array.isArray(table.columns) || !table.columns.length)
      throw Error("Invalid or duplicate contracted stream");
    const fields = {};
    const targets = /* @__PURE__ */ new Set();
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
        TIMESTAMP: "timestamp"
      }[type];
      const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(type);
      if (!mapped && !decimal)
        throw Error(
          `Snapshot projection does not support ODCS physical type ${type}`
        );
      const target = column.target ?? column.name;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || targets.has(target))
        throw Error("Invalid or duplicate target field");
      targets.add(target);
      fields[column.name] = decimal ? {
        type: "decimal",
        precision: Number(decimal[1]),
        scale: Number(decimal[2]),
        nullable: !column.required,
        ...target !== column.name ? { target } : {}
      } : {
        type: mapped,
        nullable: !column.required,
        ...target !== column.name ? { target } : {}
      };
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
    executionSchema: object(
      {
        mode: { type: "string", enum: ["local"] },
        ingestion: { type: "string", enum: ["incremental"] }
      },
      ["mode"]
    ),
    executionPlatforms: ["local"],
    scheduling: {
      apiVersion: "ingestron.connector-schedule/v1",
      clock: "portable",
      recurrences: ["interval", "daily", "weekly", "monthly"]
    },
    prepareCommand: "connection prepare",
    metadataDocuments: "ingestron.metadata-documents/v1",
    contractsCommand: "connector contracts"
  }
};
var definitions = [
  {
    name: "execution resources",
    description: "Declare the selected compiled local output namespaces without source access",
    inputSchema: object({
      packageRoot: { type: "string", minLength: 1, maxLength: 2048 },
      flows: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 100 },
        minItems: 1,
        maxItems: 100
      }
    })
  },
  projectConnectionDefinition,
  {
    name: "connector contracts",
    description: "Export reviewed ODCS contracts",
    inputSchema: object({ review: { type: "object" } })
  }
];
function prepare(request) {
  const { runtimeAssets, projectionTables, ...input } = request;
  if (!runtimeAssets || !input.runtimeAssetSha256)
    throw Error("Install a source package with locked runtime assets");
  const selection = validateProjectConnection(
    input,
    {
      ...connectorRuntimes[runtimeContract],
      settingsSchema: JSON.parse(runtimeAssets["settings.schema.json"])
    },
    projectionTables
  );
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
      "connector.json": JSON.stringify(config),
      "selection.json": JSON.stringify(selection),
      "project-connection.lock.json": JSON.stringify(input)
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
  if (request.command === "execution resources") {
    const { packageRoot, flows } = request.input;
    if (typeof packageRoot !== "string" || packageRoot.length > 2048 || !packageRoot.startsWith("/") || packageRoot.includes("\\") || packageRoot.split("/").slice(1).some((part) => !part || [".", ".."].includes(part)) || !Array.isArray(flows) || !flows.length || flows.length > 100 || new Set(flows).size !== flows.length || flows.some(
      (flow) => typeof flow !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(flow)
    ))
      throw Error(
        "Select a canonical POSIX package directory and unique compiled flows"
      );
    return {
      apiVersion: "ingestron.execution-resources/v1",
      flows: flows.map((flow) => ({
        flow,
        resources: [
          {
            namespace: "local-filesystem",
            identity: packageRoot + "/data/" + flow
          }
        ]
      }))
    };
  }
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
