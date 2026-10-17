"""Provider transports reviewed metadata; installed source acceptance proves real cursor semantics."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('checkpoint_host', Path(__file__).parents[1] / 'src/execution.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
DECLARATION = {'apiVersion': 'ingestron.checkpoint-migration/v1', 'strategy': 'preserve-cursor-runtime-upgrade'}

class CheckpointTransport(unittest.TestCase):
    def fixture(self, root):
        current, previous = root / 'build/current', root / 'build/previous'
        for folder in [current, previous]:
            (folder / 'flows/orders').mkdir(parents=True)
            (folder / 'flows/orders/connector.json').write_text('{}')
            (folder / 'flows/orders/singer_runtime.py').write_text('# source owns implementation')
            (folder / 'project-runtime.json').write_text(json.dumps({
                'project': 'retail', 'environment': 'dev', 'configuration': 'local',
                'flows': {'orders': {'directory': 'flows/orders', 'runtime': 'locked', 'checkpointMigration': DECLARATION}},
                'environments': {'locked': {}}}))
        return current, previous, {'apiVersion': 'ingestron.execution-request/v1', 'action': 'checkpoint_preview',
                'flows': ['orders'], 'cache': str(root / 'cache'), 'previousRoot': str(previous), 'projectRoot': str(root)}

    def test_preview_and_apply_invoke_only_source_maintenance_without_dependency_install_or_source_probe(self):
        for action in ('checkpoint_preview', 'checkpoint_apply'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); current, previous, request = self.fixture(root)
                request['action'] = action
                if action == 'checkpoint_apply': request['expectedDigest'] = 'a' * 64
                calls = []
                def child(args, folder, timeout):
                    calls.append(args)
                    return json.dumps({'status': 'Succeeded', 'migration': {'sourceEvidence': True}})
                with patch.object(host, '__file__', str(current / 'execute.py')), patch.object(host, 'environment', return_value=('locked-python', 'key', True)) as environment, patch.object(host, 'child', side_effect=child):
                    result = host.execute(request)
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][:2], ['locked-python', '-B'])
                self.assertEqual(calls[0][3], action)
                self.assertIn(str(previous / 'flows/orders/connector.json'), calls[0])
                self.assertIn(str(current / 'data/orders'), calls[0])
                self.assertFalse(environment.call_args.args[-1])
                self.assertEqual(result['flows'], [{'flow': 'orders', 'status': 'Succeeded', 'migration': {'sourceEvidence': True}}])
                self.assertFalse((current / 'flows/orders/review.json').exists())

    def test_missing_source_capability_foreign_scope_symlink_and_missing_digest_stop_before_source_invocation(self):
        for scenario in ('unsupported', 'foreign', 'symlink', 'digest'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); current, previous, request = self.fixture(root)
                if scenario == 'unsupported':
                    path = current / 'project-runtime.json'; value = json.loads(path.read_text()); del value['flows']['orders']['checkpointMigration']; path.write_text(json.dumps(value))
                elif scenario == 'foreign':
                    path = previous / 'project-runtime.json'; value = json.loads(path.read_text()); value['project'] = 'another'; path.write_text(json.dumps(value))
                elif scenario == 'symlink':
                    link = root / 'linked'; link.symlink_to(previous, target_is_directory=True); request['previousRoot'] = str(link)
                else: request['action'] = 'checkpoint_apply'
                with patch.object(host, '__file__', str(current / 'execute.py')), patch.object(host, 'environment', return_value=('locked-python', 'key', True)), patch.object(host, 'child') as child:
                    with self.assertRaises(ValueError): host.execute(request)
                child.assert_not_called()

    def test_durable_stale_failure_retains_only_allowlisted_code_and_acknowledges_without_source_replay(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            request = {'apiVersion': 'ingestron.execution-request/v1', 'action': 'checkpoint_apply', 'flows': ['orders'], 'cache': str(root / 'cache'), 'runId': 'migration-original', 'fingerprint': 'a' * 64, 'operationNonce': 'owned'}
            folder, binding = host.operation_location(request)
            folder.mkdir()
            host.write(folder / 'submission.json', {'binding': binding, 'nonce': 'owned'})
            with patch.object(host, 'execute', side_effect=host.SourceFailure('CHECKPOINT_MIGRATION_STALE', 'private raw source message')):
                host.operation_worker(request)
            with patch.object(host, 'execute', side_effect=AssertionError('Recovery must not replay source maintenance')):
                recovered = host.operation_acknowledgement({**request, 'action': 'acknowledge', 'originalAction': 'checkpoint_apply'})
            result = recovered['acknowledgement']['result']
            self.assertEqual(result, {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed', 'action': 'checkpoint_apply', 'flows': [], 'errorCode': 'CHECKPOINT_MIGRATION_STALE'})
            self.assertNotIn('private', json.dumps(recovered))
            invalid = recovered['acknowledgement']; invalid['result']['errorCode'] = 'PRIVATE_SECRET_OR_ROW'
            host.write(folder / 'acknowledgement.json', invalid)
            with self.assertRaisesRegex(ValueError, 'failure evidence'):
                host.operation_acknowledgement({**request, 'action': 'acknowledge', 'originalAction': 'checkpoint_apply'})

if __name__ == '__main__': unittest.main()
