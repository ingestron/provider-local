"""Source size failures retain their code and safe guidance at the provider boundary."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import execution


class MetadataLimit(unittest.TestCase):
    def test_preflight_preserves_only_known_metadata_codes_without_source_details(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'connector.json').write_text('{}')
            for code in ('SOURCE_METADATA_LIMIT', 'SOURCE_METADATA_COLLECTION_LIMIT', 'PRIVATE_SOURCE_CODE'):
                with self.subTest(code=code):
                    (root / 'singer_runtime.py').write_text(
                        'class Failure(ValueError):\n    code='+repr(code)+'\n'
                        'def runtime_identity(config,folder):\n    raise Failure("SYNTHETIC_PRIVATE_SOURCE_DETAIL")\n')
                    with self.assertRaises(ValueError) as raised:
                        execution.verify_runtime_identity(sys.executable, root)
                    self.assertNotIn('SYNTHETIC_PRIVATE_SOURCE_DETAIL', str(raised.exception))
                    if code == 'PRIVATE_SOURCE_CODE':
                        self.assertNotIsInstance(raised.exception, execution.SourceFailure)
                        self.assertNotIn(code, str(raised.exception))
                    else:
                        self.assertIsInstance(raised.exception, execution.SourceFailure)
                        self.assertEqual(raised.exception.code, code)
            (root / 'singer_runtime.py').write_text('def runtime_identity(config,folder):\n    pass\n')
            execution.verify_runtime_identity(sys.executable, root)

    def test_collection_limit_retains_exact_code_and_safe_separate_guidance(self):
        with tempfile.TemporaryDirectory() as directory:
            script = "import json;print(json.dumps({'errorCode':'SOURCE_METADATA_COLLECTION_LIMIT','error':'SYNTHETIC_PRIVATE_SOURCE_DETAIL'}));raise SystemExit(1)"
            with self.assertRaises(execution.SourceFailure) as raised:
                execution.child([sys.executable, '-c', script], Path(directory), 10)
            self.assertEqual(raised.exception.code, 'SOURCE_METADATA_COLLECTION_LIMIT')
            self.assertIn('7 MB metadata collection limit', str(raised.exception))
            self.assertIn('prepare again', str(raised.exception))
            self.assertNotIn('2 MB', str(raised.exception))
            self.assertNotIn('SYNTHETIC_PRIVATE_SOURCE_DETAIL', str(raised.exception))

    def test_collection_failure_acknowledgement_preserves_only_the_code(self):
        with tempfile.TemporaryDirectory() as directory:
            request = {'apiVersion': 'ingestron.execution-request/v1', 'action': 'review',
                       'flows': ['records'], 'cache': str(Path(directory).resolve() / 'cache'),
                       'runId': 'collection-original', 'fingerprint': 'a' * 64, 'operationNonce': 'owned'}
            folder, binding = execution.operation_location(request)
            folder.mkdir()
            execution.write(folder / 'submission.json', {'binding': binding, 'nonce': 'owned'})
            with patch.object(execution, 'execute', side_effect=execution.SourceFailure('SOURCE_METADATA_COLLECTION_LIMIT', 'SYNTHETIC_PRIVATE_SOURCE_DETAIL')):
                execution.operation_worker(request)
            with patch.object(execution, 'execute', side_effect=AssertionError('Recovery must not replay source review')):
                response = execution.operation_acknowledgement({**request, 'action': 'acknowledge', 'originalAction': 'review'})
            self.assertEqual(response['acknowledgement']['result'], {
                'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed',
                'action': 'review', 'flows': [], 'errorCode': 'SOURCE_METADATA_COLLECTION_LIMIT'})
            self.assertNotIn('SYNTHETIC_PRIVATE_SOURCE_DETAIL', json.dumps(response))

    def test_metadata_limit_retains_code_without_upstream_details(self):
        with tempfile.TemporaryDirectory() as directory:
            script = "import json;print(json.dumps({'errorCode':'SOURCE_METADATA_LIMIT','error':'SYNTHETIC_PRIVATE_SOURCE_DETAIL'}));raise SystemExit(1)"
            with self.assertRaises(execution.SourceFailure) as raised:
                execution.child([sys.executable, '-c', script], Path(directory), 10)
            self.assertEqual(raised.exception.code, 'SOURCE_METADATA_LIMIT')
            self.assertIn('Split tables into smaller flows', str(raised.exception))
            self.assertNotIn('SYNTHETIC_PRIVATE_SOURCE_DETAIL', str(raised.exception))

    def test_durable_metadata_failure_keeps_only_its_code_without_replaying(self):
        with tempfile.TemporaryDirectory() as directory:
            request = {'apiVersion': 'ingestron.execution-request/v1', 'action': 'review',
                       'flows': ['records'], 'cache': str(Path(directory).resolve() / 'cache'),
                       'runId': 'metadata-original', 'fingerprint': 'a' * 64, 'operationNonce': 'owned'}
            folder, binding = execution.operation_location(request)
            folder.mkdir()
            execution.write(folder / 'submission.json', {'binding': binding, 'nonce': 'owned'})
            with patch.object(execution, 'execute', side_effect=execution.SourceFailure('SOURCE_METADATA_LIMIT', 'SYNTHETIC_PRIVATE_SOURCE_DETAIL')):
                execution.operation_worker(request)
            with patch.object(execution, 'execute', side_effect=AssertionError('Recovery must not replay source review')):
                response = execution.operation_acknowledgement({**request, 'action': 'acknowledge', 'originalAction': 'review'})
            result = response['acknowledgement']['result']
            self.assertEqual(result, {'apiVersion': 'ingestron.execution-result/v1', 'status': 'failed',
                                     'action': 'review', 'flows': [], 'errorCode': 'SOURCE_METADATA_LIMIT'})
            self.assertNotIn('SYNTHETIC_PRIVATE_SOURCE_DETAIL', json.dumps(response))
            result['errorCode'] = 'PRIVATE_SOURCE_CODE'
            execution.write(folder / 'acknowledgement.json', response['acknowledgement'])
            with self.assertRaisesRegex(ValueError, 'failure evidence'):
                execution.operation_acknowledgement({**request, 'action': 'acknowledge', 'originalAction': 'review'})
