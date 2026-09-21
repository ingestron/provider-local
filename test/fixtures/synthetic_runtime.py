"""Test-only source: standard-library JSON snapshots, not a production connector."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def create(path, value):
    with path.open('x') as file:
        json.dump(value, file, sort_keys=True)


def runtime_identity(config, root):
    lock = read(root / 'runtime.lock.json')
    assert lock['connector'] == config['connector']
    for name, expected in lock['files'].items():
        assert digest((root / name).read_bytes()) == expected
    return config['projectLock']['specificationSha256']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['discover', 'review', 'approve', 'run'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--output')
    parser.add_argument('--discovery')
    parser.add_argument('--run-id')
    args = parser.parse_args()
    root = Path(args.config).parent
    config = read(Path(args.config))
    identity = runtime_identity(config, root)
    selection = read(root / 'selection.json')
    review_path = root / 'review.json'
    if args.action == 'discover':
        create(Path(args.output), {'users': {'id': 'integer', 'age': 'integer'}})
    elif args.action == 'review':
        discovery = read(Path(args.discovery))
        assert set(selection) == {'users'}
        for field, spec in selection['users']['fields'].items():
            assert discovery['users'][field] == spec['type']
        create(Path(args.output), {'status': 'draft', 'identity': identity, 'selection': selection})
    elif args.action == 'approve':
        review = read(review_path)
        assert review['identity'] == identity and review['selection'] == selection
        review['status'] = 'approved'
        review_path.write_text(json.dumps(review))
    else:
        review = read(review_path)
        assert review['status'] == 'approved' and review['identity'] == identity
        assert review['selection'] == selection
        output = Path(args.output) / args.run_id
        receipt = output / 'commit.json'
        if receipt.exists():
            result = read(receipt)
            assert result['identity'] == identity
            assert digest((output / 'users.json').read_bytes()) == result['tables'][0]['sha256']
        else:
            output.mkdir(parents=True)
            rows = [{name: (i if name == 'id' else 20 + i) for name in selection['users']['fields']} for i in range(config['sourceSettings']['count'])]
            create(output / 'users.json', rows)
            result = {'status': 'committed', 'identity': identity, 'tables': [{'stream': 'users', 'rows': len(rows), 'sha256': digest((output / 'users.json').read_bytes())}]}
            create(receipt, result)
        print(json.dumps(result))
        return
    print(json.dumps({'status': 'succeeded'}))


if __name__ == '__main__':
    main()
