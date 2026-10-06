"""Local host for locked source access; no connector protocols or implementations."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from execution import inside, load, environment, child, require


def execute(request):
    require(request.get('apiVersion') == 'ingestron.source-access-host-request/v1' and os.name == 'posix',
            'Unsupported source access host protocol/platform')
    root = Path(request['directory'])
    cache = Path(request['cache'])
    require(root.is_absolute() and cache.is_absolute() and not root.is_symlink() and not cache.is_symlink(),
            'Source access directories must be private regular paths')
    spec = load(inside(root, 'source-access.json'))
    require(spec.get('apiVersion') == 'ingestron.source-access-request/v1', 'Unsupported source access request')
    entry = spec.get('entryPoint')
    require(isinstance(entry, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*', entry), 'Invalid source entry point')
    lock = load(inside(root, 'runtime.lock.json'))
    require(lock.get('apiVersion') == 'ingestron.singer-runtime-lock/v1' and isinstance(lock.get('files'), dict),
            'Invalid source runtime lock')
    require(entry in lock['files'] and len(lock['files']) <= 100, 'Source method is not in the runtime lock')
    for name, expected in lock['files'].items():
        require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected), 'Invalid runtime file digest')
        require(hashlib.sha256(inside(root, name).read_bytes()).hexdigest() == expected, 'Source runtime file digest differs')
    action = spec.get('action')
    require(action in ('prepare', 'test', 'inventory', 'metadata', 'sample'), 'Unsupported source action')
    python, key, reused = environment(root, {'requirements': 'requirements.lock.txt', 'buildTools': 'build-tools.lock.txt'},
                                      cache, request, action == 'prepare')
    if action == 'prepare':
        result = {'apiVersion': 'ingestron.source-access-prepared/v1', 'status': 'succeeded', 'environment': key, 'reused': reused}
    else:
        child([python, "-c", "from singer_inventory import inventory; inventory('requirements.lock.txt')"], root, 120)
        result = json.loads(child([python, str(inside(root, entry)), str(inside(root, 'source-access.json'))], root, 180))
        require(result.get('apiVersion') == 'ingestron.source-access-result/v1' and result.get('action') == action, 'Invalid source response')
        if action == 'sample' and result.get('status') == 'succeeded':
            preview = result.get('sample', {})
            require(isinstance(preview.get('columns'), list) and 1 <= len(preview['columns']) <= 100
                    and isinstance(preview.get('rows'), list) and len(preview['rows']) <= min(spec.get('limit', 20), 50)
                    and all(isinstance(row, list) and len(row) == len(preview['columns']) for row in preview['rows'])
                    and len(json.dumps(result).encode()) <= 1_000_000, 'Source sample exceeds its bounds')
    return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'succeeded', 'result': result}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.read(2_000_001))
        result = execute(request)
    except KeyboardInterrupt:
        result = {'apiVersion': 'ingestron.execution-result/v1', 'status': 'interrupted', 'message': 'Source access interrupted'}
    except Exception:
        # No upstream exception text, host paths or credentials leave this boundary.
        result = {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed',
                  'message': 'Source access host failed. Check Python 3.12, locked dependencies and runtime preparation.'}
    print(json.dumps(result))
    sys.exit(0 if result['status'] == 'succeeded' else 1)
