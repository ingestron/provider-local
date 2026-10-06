"""Current installed sixteen-source matrix; synthetic fixtures, never live accounts.

Preparation and execution are separate phases. The frozen manifest and runtime
maps come from runtime-matrix-prepare.mjs. The CLI/core are installed archives.
HTTP transport uses frozen source-owned mocks. Database/OpenSSH transport
qualification is recorded separately from installed connector behaviour.
"""
from contextlib import ExitStack
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time
import uuid
from urllib.parse import parse_qs, unquote, urlsplit
from xml.sax.saxutils import escape


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('config', type=Path)
    parser.add_argument('--phase', choices=['archives', 'prepare', 'execute', 'client'], required=True)
    parser.add_argument('--client-script', type=Path, help='Owning client adapter; JSON input/output, while frozen transports are active')
    parser.add_argument('--client-scenario', choices=['standard', 'contract-quality'], default='standard')
    parser.add_argument('--only', help='Bounded rerun; never counts as all-sixteen completion')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if args.phase == 'client':
        assert args.client_script and args.client_script.is_file(), 'Choose an owning client adapter'
    assert config['candidate'] in [
        {'cli': '0.17.18', 'core': version, 'declaredCore': '0.12.14', 'privateOverride': True}
        for version in ('0.12.42', '0.12.43')] + [
        {'cli': '0.17.20', 'core': '0.12.47', 'declaredCore': '0.12.14', 'privateOverride': True},
        {'cli': '0.17.21', 'core': '0.12.50', 'declaredCore': '0.12.14', 'privateOverride': True},
        {'cli': '0.17.21', 'core': '0.12.51', 'declaredCore': '0.12.14', 'privateOverride': True},
        {'cli': '0.17.21', 'core': '0.12.53', 'declaredCore': '0.12.14', 'privateOverride': True}]
    cli_manifest = json.loads((Path(config['cli']).parents[3] / 'package.json').read_text())
    core_manifest = json.loads((Path(config['core']) / 'package.json').read_text())
    assert cli_manifest['version'] == config['candidate']['cli']
    assert core_manifest['version'] == config['candidate']['core']
    assert cli_manifest['dependencies']['@ingestron/core'] == config['candidate']['declaredCore']
    assert len(config['records']) == 16
    root, base = Path(config['root']), Path(config['base'])
    archive_parity = {}
    for name, installed in [('CORE_ARCHIVE', Path(config['core'])), ('CLI_ARCHIVE', Path(config['cli']).parents[3])]:
        path = Path(config['archives'][name]['path'])
        assert hashlib.sha256(path.read_bytes()).hexdigest() == config['archives'][name]['sha256']
        count = 0
        with tarfile.open(path, 'r:gz') as archive:
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                relative = Path(member.name)
                assert relative.parts[0] == 'package' and '..' not in relative.parts
                file = installed.joinpath(*relative.parts[1:])
                assert file.is_file() and hashlib.sha256(file.read_bytes()).digest() == hashlib.sha256(archive.extractfile(member).read()).digest(), 'Installed package differs from immutable archive'
                count += 1
        archive_parity[name] = count
    records = config['records']
    if args.only:
        selected = set(args.only.split(','))
        assert selected <= {r['id'] for r in records}
        records = [r for r in records if r['id'] in selected]
    if args.client_scenario == 'contract-quality':
        assert args.phase == 'client' and {item['id'] for item in records} == {'github', 'jira'}, 'Business-field quality scenario is bounded to GitHub and Jira'
    authored_file = root / 'project.yaml'
    authored_before = authored_file.read_bytes()
    data_file = Path(config.get('sourceData', str(Path(config['fixtures']) / 'data'))) / 'orders.csv'
    data_before = data_file.read_bytes()
    # Known synthetic values only. They are omitted from receipts and proof.
    env = {**os.environ, **{r['secretName']: 'matrix-' + r['id'] + '-synthetic-secret' for r in config['records']}}
    # The outer provider host and the venv bootstrap must use the same Python.
    env['PATH'] = str(Path(config['python']).parent) + os.pathsep + env.get('PATH', '')
    env['INGESTRON_MATRIX_AZURE_BLOB'] = 'sv=2023-11-03&sp=rl&se=2030-01-01&spr=https&sig=matrix-signature'
    env['INGESTRON_MATRIX_STRIPE'] = 'rk_test_MatrixSyntheticAcceptance0123'
    env['INGESTRON_MATRIX_SFTP'] = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nSyntheticFixtureOnly\n-----END OPENSSH PRIVATE KEY-----'
    env['INGESTRON_MATRIX_TRANSPORT_STATE'] = str(base / 'transport-state.json')
    checks, results = [], []
    run_prefix = 'matrix_' + uuid.uuid4().hex[:12] + '_'
    private_values = ['MATRIX_PRIVATE_ROW', 'MATRIX_UNSELECTED_PRIVATE', 'secret-row-value', 'secret-value', 'secret-tempauth', *[env[r['secretName']] for r in config['records'] if r['id'] != 'files']]
    proof = {'result': 'failed', 'phase': args.phase, 'candidate': config['candidate'], 'provider': config['provider'], 'archives': config['archives'], 'archiveParity': archive_parity, 'sources': results, 'checks': checks, 'matrixSize': 16, 'selectedSize': len(records), 'liveAccounts': False, 'vendorQualified': False, 'browserInteraction': False, 'config': str(args.config)}
    if args.phase == 'client':
        proof['clientAdapter'] = {'path': str(args.client_script.resolve()), 'sha256': hashlib.sha256(args.client_script.read_bytes()).hexdigest()}
        proof['clientScenario'] = args.client_scenario

    def cli(*commands, ok=True, input=None, permissions=False):
        command = ['node', config['cli'], '--project', str(root), '--json', '--no-input', *commands]
        if permissions:
            command += ['--allow-write', '--allow-execute', '--allow-network']
        child = subprocess.run(command, input=None if input is None else json.dumps(input), env=env,
                               capture_output=True, text=True, timeout=1200)
        try:
            value = json.loads(child.stdout)
        except Exception:
            raise AssertionError('CLI did not return JSON; operation=' + ' '.join(commands[:2]) + '; exit=' + str(child.returncode)) from None
        if value.get('ok') != ok:
            codes = [d.get('code') for d in value.get('diagnostics', [])]
            raise AssertionError('Unexpected CLI outcome: ' + ' '.join(commands) + '; codes=' + repr(codes))
        return value

    def op(operation, request, **kwargs):
        return cli('operation', operation, input=request, permissions=kwargs.pop('permissions', True), **kwargs)

    def private(value):
        text = json.dumps(value)
        assert not any(secret in text for secret in private_values), 'Private payload persisted or echoed'

    def record(item, name):
        checks.append({'source': item['id'], 'check': name})

    def all_files():
        folder = root / 'build/generated/data'
        return list(folder.rglob('*')) if folder.exists() else []

    def no_commit(run_id):
        assert not any(p.is_file() and run_id in p.parts for p in all_files()), 'Rejected run published output'

    try:
        if args.phase == 'archives':
            proof['result'] = 'passed'
            print('Installed CLI/core bytes match both immutable archives', flush=True)
        elif args.phase == 'prepare':
            cli('check')
            cli('build')
            for item in records:
                selection = {'connection': item['id'], 'executor': config['provider']}
                access = op('connection_access', selection)['result']
                assert access['actions'] == item['actions']
                record(item, 'Installed declared source access')
                denied = op('connection_sample', {**selection, 'source': item['source'], 'limit': 2}, ok=False, permissions=False)
                assert any('PERMISSION' in d['code'] for d in denied['diagnostics'])
                private(denied)
                record(item, 'Sample execution permission refused before access')
                first = op('connection_runtime_prepare', {**selection, 'python': config['python']})['result']
                second = op('connection_runtime_prepare', {**selection, 'python': config['python']})['result']
                assert second['reused'] is True
                prepared = cli('runtime', 'prepare', '--flow', item['flow'], '--python', config['python'])['result']
                record(item, 'Source access and generated flow prepare exact locked runtimes')
                results.append({'id': item['id'], 'reference': item['reference'], 'runtimeSha256': item['runtimeSha256'], 'sourceRuntime': first, 'flowRuntime': prepared})
                print(item['id'] + ': installed access, permission denial and locked preparation passed', flush=True)
            proof['result'] = 'passed'
        else:
            sys.path.insert(0, str(Path(config['fixtures']) / 'mocks'))
            sys.path.insert(0, config['fixtures'])
            from loopback import loopback
            from github_fixture import github_fixture
            from stripe_api import StripeApi
            from graph_api import GraphApi
            from saas_api import SalesforceApi, HubSpotApi, JiraApi
            from s3_api import S3Api
            contents = {'retail/orders.csv': b'id,label\n1,MATRIX_PRIVATE_ROW\n2,Second\n3,Third\n', 'retail/products.csv': b'id,label\n4,Product\n'}
            stripe = StripeApi(env['INGESTRON_MATRIX_STRIPE'])
            salesforce = SalesforceApi('matrix-client', env['INGESTRON_MATRIX_SALESFORCE'])
            hubspot = HubSpotApi(env['INGESTRON_MATRIX_HUBSPOT'])
            jira = JiraApi('reader@example.invalid', env['INGESTRON_MATRIX_JIRA'])
            graph = GraphApi(env['INGESTRON_MATRIX_SHAREPOINT'])
            graph.page_size = 1
            # Both Graph sources have their own secret name and equal test value.
            env['INGESTRON_MATRIX_ONEDRIVE'] = env['INGESTRON_MATRIX_SHAREPOINT']
            s3 = S3Api('matrix-key', 'bronze.s3.us-east-1.amazonaws.com', 'bronze', False)
            gcs = S3Api('matrix-key', 'storage.googleapis.com', 'bronze', True)
            request_counts, github_mode = [], {'mode': 'normal'}

            def load(mode='normal'):
                github_mode['mode'] = 'contract-quality' if mode == 'contract-quality' else 'normal'
                count = 0 if mode == 'empty' else 3
                ids = [1, 1, 3] if mode == 'quality' else [1, 2, 3]
                csv = ('id,label\n' + ''.join(f'{i},MATRIX_PRIVATE_ROW\n' for i in ids[:count])).encode()
                contents['retail/orders.csv'] = csv
                (Path(config.get('sourceData', str(Path(config['fixtures']) / 'data'))) / 'orders.csv').write_bytes(csv)
                s3.objects = dict(contents); gcs.objects = dict(contents)
                for drive in graph.drives:
                    for path, body in contents.items(): graph.put(drive, path, body)
                stripe.load('customers', [{'id': 'cus_' + str(i), 'object': 'customer', 'created': 1760000000, 'livemode': False, 'email': None, 'name': 'MATRIX_PRIVATE_ROW', 'description': None, 'phone': None, 'currency': 'nzd', 'balance': 0, 'delinquent': False} for i in ids[:count]])
                salesforce.load('Account', {'Id': 'string', 'Name': 'string'}, [{'Id': 'id_' + str(i), 'Name': 'MATRIX_PRIVATE_ROW'} for i in ids[:count]])
                hubspot.load('contacts', {'email': 'string'}, [{'id': 'id_' + str(i), 'email': 'MATRIX_PRIVATE_ROW'} for i in ids[:count]])
                jira.fields = [{'id': 'summary', 'schema': {'type': 'string'}}]
                jira.issues = [{'id': 'id_' + str(i), 'key': 'RETAIL-' + str(n), 'fields': {'summary': 'MATRIX_PRIVATE_ROW' + ('_' + str(i) if mode == 'quality-baseline' else '')}} for n, i in enumerate(ids[:count])]
                Path(env['INGESTRON_MATRIX_TRANSPORT_STATE']).write_text(json.dumps({'source': env.get('INGESTRON_MATRIX_SOURCE'), 'mode': mode, 'rows': [[i, 'MATRIX_PRIVATE_ROW'] for i in ids[:count]], 'contents': {key: value.decode() for key, value in contents.items()}}))

            def handle(host, method, target, headers, body):
                path = unquote(urlsplit(target).path)
                request_counts.append((host, method, path))
                if host == 'api.stripe.com':
                    if path == '/v1/account':
                        return (200, {'id': 'acct_matrix', 'object': 'account'}) if headers.get('Authorization') == 'Bearer ' + stripe.key else (401, {})
                    return stripe.handle(method, target, headers)
                if host == 'api.github.com':
                    assert headers.get('Authorization') == 'Bearer ' + env['INGESTRON_MATRIX_GITHUB']
                    if path == '/repos/demo/repo': return 200, {'id': 1, 'name': 'repo', 'full_name': 'demo/repo', 'owner': {'login': 'demo'}}
                    assert path == '/repos/demo/repo/issues'
                    query = parse_qs(urlsplit(target).query)
                    rows = [{'id': i, 'number': i, 'title': 'Repeated issue title' if github_mode['mode'] == 'contract-quality' else 'Issue ' + str(i), 'state': 'open', 'updated_at': '2026-01-01T00:00:00Z'} for i in (1, 2)]
                    start = (int(query.get('page', ['1'])[0]) - 1) * int(query.get('per_page', ['2'])[0])
                    return 200, rows[start:start + int(query.get('per_page', ['2'])[0])]
                if host == salesforce.host: return salesforce.handle(host, method, target, headers, body)
                if host == hubspot.host: return hubspot.handle(host, method, target, headers, body)
                if host == jira.host: return jira.handle(host, method, target, headers, body)
                if host in ('login.microsoftonline.com', 'graph.microsoft.com', 'contoso.sharepoint.com'): return graph.handle(host, method, target, headers, body)
                if host in (s3.host, gcs.host):
                    store = s3 if host == s3.host else gcs
                    store.page_size = min(2, int(parse_qs(urlsplit(target).query).get('max-keys', ['2'])[0]))
                    return store.handle(host, method, target, headers)
                assert host == 'sampleaccount.blob.core.windows.net'
                query = parse_qs(urlsplit(target).query)
                if query.get('comp') == ['list']:
                    prefix = query.get('prefix', [''])[0]
                    names = [key for key in sorted(contents) if key.startswith(prefix)]
                    start = int(query.get('marker', ['0'])[0])
                    limit = int(query.get('maxresults', ['2'])[0])
                    page = names[start:start + limit]
                    next_marker = str(start + limit) if start + limit < len(names) else ''
                    xml = '<EnumerationResults><Blobs>' + ''.join('<Blob><Name>' + escape(key) + '</Name><Properties><Content-Length>' + str(len(contents[key])) + '</Content-Length></Properties></Blob>' for key in page) + '</Blobs><NextMarker>' + next_marker + '</NextMarker></EnumerationResults>'
                    return 200, xml.encode()
                key = path.removeprefix('/samples/')
                if key not in contents: return 404, b'not found'
                content = contents[key]
                return 200, content, {'ETag': '"' + hashlib.sha256(content).hexdigest() + '"'}

            hosts = {'api.stripe.com', 'api.github.com', salesforce.host, hubspot.host, jira.host, 'login.microsoftonline.com', 'graph.microsoft.com', 'contoso.sharepoint.com', s3.host, gcs.host, 'sampleaccount.blob.core.windows.net'}
            preparation = json.loads((base / 'prepare-proof.json').read_text())
            assert preparation['result'] == 'passed' and preparation['selectedSize'] == 16, 'All sixteen exact locks must be prepared first'
            runtime_keys = {r['id']: r['flowRuntime']['result']['flows'][0]['environment'] for r in preparation['sources']}
            transport_fixture = Path(config['fixtures']) / 'mocks/runtime_matrix_transport.py'
            proof['transportFixtureSha256'] = hashlib.sha256(transport_fixture.read_bytes()).hexdigest()
            proof['githubFixtureSha256'] = hashlib.sha256((Path(config['fixtures']) / 'github_fixture.py').read_bytes()).hexdigest()
            sites = []
            for area in ['runtime-cache', 'runtimes']:
                for python in sorted((root / '.ingestron' / area).glob('*/bin/python')):
                    site = Path(subprocess.check_output([str(python), '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], text=True).strip())
                    if site not in sites: sites.append(site)
            assert sites, 'Prepare exact source/flow locks first'
            with ExitStack() as stack:
                github_requests = []
                for site in sites:
                    stack.enter_context(loopback(site, handle, hosts))
                    if runtime_keys['github'] in site.parts:
                        github_requests = stack.enter_context(github_fixture(site, github_mode, 'demo/repo'))
                    code, hook = site / 'ingestron_matrix_transport.py', site / 'ingestron_matrix_transport.pth'
                    assert not code.exists() and not hook.exists()
                    stack.callback(code.unlink, missing_ok=True)
                    stack.callback(hook.unlink, missing_ok=True)
                    code.write_text('import os\nos.environ["INGESTRON_MATRIX_TRANSPORT_STATE"] = ' + repr(env['INGESTRON_MATRIX_TRANSPORT_STATE']) + '\n' + transport_fixture.read_text())
                    hook.write_text('import ingestron_matrix_transport\n')
                def observed_count():
                    path = Path(env['INGESTRON_MATRIX_TRANSPORT_STATE']).with_suffix('.requests.jsonl')
                    return len(request_counts) + len(github_requests) + (len(path.read_text().splitlines()) if path.exists() else 0)
                def execute_case(item):
                    env['INGESTRON_MATRIX_SOURCE'] = item['id']
                    load()
                    if args.phase == 'client':
                        stages = ['baseline', 'quality', 'repair'] if args.client_scenario == 'contract-quality' else ['standard']
                        phase_results, previous, owned_authored = [], None, authored_file.read_bytes()
                        try:
                            for stage in stages:
                                if args.client_scenario == 'contract-quality':
                                    load('contract-quality' if stage == 'quality' else 'quality-baseline')
                                assert hashlib.sha256(args.client_script.read_bytes()).hexdigest() == proof['clientAdapter']['sha256'], 'Client adapter changed during qualification'
                                child = subprocess.run(['node', str(args.client_script.resolve())], input=json.dumps({'config': config, 'source': item, 'qualityStage': stage, 'previous': previous}), env=env, text=True, capture_output=True, timeout=600)
                                try:
                                    result = json.loads(child.stdout)
                                except Exception:
                                    raise AssertionError('Client adapter did not return a bounded JSON proof') from None
                                private(result)
                                if args.client_scenario == 'contract-quality':
                                    (base / ('contract-quality-' + item['id'] + '-' + stage + '-proof.json')).write_text(json.dumps(result, indent=2) + '\n')
                                assert child.returncode == 0 and result.get('result') == 'passed', 'Client adapter failed; stage=' + str(result.get('stage')) + '; reason=' + str(result.get('failure'))
                                assert result['id'] == item['id'] and result['reference'] == item['reference']
                                previous = result.get('continuation')
                                phase_results.append(result)
                                for check in result['checks']:
                                    record(item, check)
                        finally:
                            if args.client_scenario == 'contract-quality':
                                authored_file.write_bytes(owned_authored)
                        if args.client_scenario == 'contract-quality':
                            result = {'id': item['id'], 'reference': item['reference'], 'result': 'passed', 'scenario': args.client_scenario, 'phases': phase_results, 'authoredRestored': authored_file.read_bytes() == owned_authored}
                        results.append(result)
                        print(item['id'] + ': installed owning-client acceptance passed', flush=True)
                        return
                    selection = {'connection': item['id'], 'executor': config['provider']}
                    private(op('connection_test', {**selection, 'source': item['source']}))
                    inventory_request = {**selection, 'limit': 1, **({'scope': item['scope']} if item.get('scope') else {})}
                    inventory = op('connection_inventory', inventory_request)['result']
                    assert inventory['tables'], 'No source objects returned'
                    private(inventory)
                    if inventory.get('nextCursor'):
                        next_page = op('connection_inventory', {**inventory_request, 'cursor': inventory['nextCursor']})['result']
                        assert not {t['id'] for t in inventory['tables']} & {t['id'] for t in next_page['tables']}
                        private(next_page)
                    metadata = op('connection_metadata', {**selection, 'tables': [item['source']]})['result']
                    assert len(metadata['tables']) == 1
                    assert set(item['columns']) <= {c['name'] for c in metadata['tables'][0]['columns']}
                    private(metadata)
                    record(item, 'Explicit connection test, inventory and metadata contain no row values')
                    before_sample = sorted(str(p) for p in all_files())
                    sample = op('connection_sample', {**selection, 'source': item['source'], 'limit': 1, 'columns': item['columns']})['result']['sample']
                    assert len(sample['rows']) == 1 and sample['columns'] == item['columns'] and sample['truncated'] is True
                    assert before_sample == sorted(str(p) for p in all_files())
                    rejected = op('connection_sample', {**selection, 'source': item['source'], 'limit': 51}, ok=False)
                    private(rejected)
                    record(item, 'Bounded explicit sample; invalid limit refused; no output writes')
                    for action in ['discover', 'review']:
                        cli('run', '--flow', item['flow'], '--action', action)
                    denied_id = run_prefix + item['id'].replace('-', '_') + '_unapproved'
                    private(cli('run', '--flow', item['flow'], '--run-id', denied_id, ok=False))
                    no_commit(denied_id)
                    cli('run', '--flow', item['flow'], '--action', 'approve')
                    run_id = run_prefix + item['id'].replace('-', '_') + '_snapshot'
                    run = cli('run', '--flow', item['flow'], '--run-id', run_id)['result']
                    assert run['result']['flows'][0]['tables'][0]['rows'] == item['rows']
                    outputs = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in all_files() if p.is_file() and run_id in p.parts}
                    assert outputs
                    python = root / '.ingestron/runtimes' / runtime_keys[item['id']] / 'bin/python'
                    parquets = [path for path in outputs if path.endswith('.parquet')]
                    assert len(parquets) == 1
                    data = json.loads(subprocess.check_output([str(python), '-c', 'import sys,json,pyarrow.parquet as p;t=p.read_table(sys.argv[1]);print(json.dumps({"columns":t.column_names,"rows":t.to_pylist()}))', parquets[0]], env=env, text=True))
                    assert set(data['columns']) == set(item['columns']) and len(data['columns']) == len(item['columns']), 'Snapshot projection differs from reviewed contract'
                    keys = [row[item['columns'][0]] for row in data['rows']]
                    expected_keys = [1, 2] if item['id'] == 'github' else ['cus_' + str(i) for i in range(1, 4)] if item['id'] == 'stripe' else ['id_' + str(i) for i in range(1, 4)] if item['id'] in ('salesforce', 'hubspot', 'jira') else [1, 2, 3]
                    assert keys == expected_keys, 'Snapshot values or key types differ'
                    assert 'MATRIX_UNSELECTED_PRIVATE' not in json.dumps(data)
                    observed = observed_count()
                    cli('run', '--retry', run_id)
                    assert observed == observed_count(), 'Retry accessed source transport again'
                    assert outputs == {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in outputs}
                    record(item, 'Reviewed Parquet exact projection/count/key values, unapproved denial and unchanged source-free retry')
                    if item['id'] != 'github':
                        load('quality')
                        failure_id = run_prefix + item['id'].replace('-', '_') + '_quality'
                        failed = cli('run', '--flow', item['flow'], '--run-id', failure_id, ok=False)
                        assert failed['diagnostics'][0]['code'] == ('RUNTIME' if item['id'] == 'jira' else 'QUALITY_FAILED')
                        private(failed)
                        no_commit(failure_id)
                        load()
                        cli('run', '--retry', failure_id)
                        record(item, 'Repeated Jira source ID rejected before publication; corrected same-run retry' if item['id'] == 'jira' else 'Duplicate contract key rejected before publication; corrected same-run retry')
                    for area in ['source-access', 'studio-jobs']:
                        for path in (root / '.ingestron' / area).rglob('*.json'):
                            private(json.loads(path.read_text()))
                    transport = 'local files' if item['id'] == 'files' else 'DB-API stand-in; no real driver/engine' if item['id'] in ('postgresql', 'mysql', 'oracle', 'sql-server') else 'OpenSSH transport stand-in; no SSH server' if item['id'] == 'sftp' else 'synthetic loopback HTTP'
                    results.append({'id': item['id'], 'result': 'passed', 'reference': item['reference'], 'rows': item['rows'], 'outputFiles': len(outputs), 'transport': transport, 'metadataCode': metadata.get('code'), 'inventoryCode': inventory.get('code')})
                    print(item['id'] + ': installed metadata, bounded sample, reviewed snapshot and retry passed', flush=True)
                for item in records:
                    try:
                        execute_case(item)
                    except AssertionError as error:
                        results.append({'id': item['id'], 'result': 'failed', 'reference': item['reference'], 'failure': str(error)})
                        print(item['id'] + ': FAILED ' + str(error), flush=True)
            proof['fixtureHooksRemoved'] = all(not (site / name).exists() for site in sites for name in ['ingestron_loopback.pth', 'ingestron_loopback.py', 'ingestron_synthetic_transport.pth', 'ingestron_synthetic_transport.py', 'ingestron_matrix_transport.pth', 'ingestron_matrix_transport.py'])
            assert proof['fixtureHooksRemoved']
            if args.phase == 'client':
                assert hashlib.sha256(args.client_script.read_bytes()).hexdigest() == proof['clientAdapter']['sha256'], 'Client adapter changed during qualification'
            proof['transportRequests'] = len(request_counts)
            proof['result'] = 'passed' if all(r.get('result') == 'passed' for r in results) else 'failed'
            assert proof['result'] == 'passed', 'Some installed source journeys failed; inspect per-source proof'
        proof['allSixteenComplete'] = len(records) == 16 and len(results) == 16 and proof['result'] == 'passed' and args.phase == 'execute'
        proof['allSixteenClientCasesPassed'] = len(records) == 16 and len(results) == 16 and proof['result'] == 'passed' and args.phase == 'client'
    except BaseException as error:
        # No raw source values, URLs, headers or credentials in a failure receipt.
        proof['failure'] = {'type': type(error).__name__, 'message': str(error) if isinstance(error, AssertionError) else 'Runtime matrix operation failed; details withheld'}
        raise
    finally:
        if args.client_scenario == 'contract-quality':
            authored_file.write_bytes(authored_before)
            data_file.write_bytes(data_before)
            proof['authoredRestored'] = hashlib.sha256(authored_file.read_bytes()).digest() == hashlib.sha256(authored_before).digest()
            proof['sourceDataRestored'] = data_file.read_bytes() == data_before
        proof['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        proof_name = args.phase if args.client_scenario == 'standard' else args.phase + '-' + args.client_scenario
        (base / (proof_name + '-proof.json')).write_text(json.dumps(proof, indent=2) + '\n')


if __name__ == '__main__':
    main()
