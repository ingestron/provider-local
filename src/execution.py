"""Explicit local execution adapter. No source implementation lives here."""
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
    temporary.write_text(json.dumps(data, sort_keys=True) + '\n')
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
    lock_key = digest(requirements.read_bytes() + b'\0' + tools.read_bytes() + platform.platform().encode() + platform.machine().encode())
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
                        require(not text or text.startswith('#') or re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+(?:\s*;[A-Za-z0-9_ .\"\'=!<>()-]+)?(?:\s*\\)?', text) or re.fullmatch(r'--hash=sha256:[a-f0-9]{64}(?:\s*\\)?', text), 'Unsupported dependency lock syntax')
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
