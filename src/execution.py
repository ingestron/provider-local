"""Explicit local execution adapter. No source implementation lives here."""
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
        staged = folder / ('.' + action + '.' + uuid.uuid4().hex + '.tmp') if action in ('discover', 'review') else None
        if action == 'discover':
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
                    names = ('discovery.json', 'review.json') if action == 'discover' else ('review.json',)
                    for name in names:
                        previous = folder / name
                        require(not previous.is_symlink(), 'Evidence cannot be a symlink')
                        if previous.exists():
                            shutil.copy2(previous, history / (name[:-5] + '-' + uuid.uuid4().hex + '.json'))
                    staged.replace(folder / ('discovery.json' if action == 'discover' else 'review.json'))
                    if action == 'discover':
                        (folder / 'review.json').unlink(missing_ok=True)
            finally:
                if staged is not None: staged.unlink(missing_ok=True)
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
