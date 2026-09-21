export const runner = String.raw`"""Generated Ingestron project runner. Extraction remains owned by source packages."""
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
