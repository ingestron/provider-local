import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import source_access_host as host


class SourceAccessHost(unittest.TestCase):
    def fixture(self, root):
        files = {'source_access.py': '# fixture', 'requirements.lock.txt': '# empty', 'build-tools.lock.txt': '# empty'}
        for name, data in files.items(): (root / name).write_text(data)
        (root / 'runtime.lock.json').write_text(json.dumps({'apiVersion': 'ingestron.singer-runtime-lock/v1', 'files': {k: hashlib.sha256(v.encode()).hexdigest() for k,v in files.items()}}))
        (root / 'source-access.json').write_text(json.dumps({'apiVersion':'ingestron.source-access-request/v1','entryPoint':'source_access.py','action':'test'}))
        cache = root / 'cache'; cache.mkdir()
        return {'apiVersion':'ingestron.source-access-host-request/v1','directory':str(root),'cache':str(cache)}

    def test_host_checks_locked_assets_before_preparation_or_access(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); request = self.fixture(root)
            with patch.object(host, 'environment', return_value=('python','fixture',True)) as environment, patch.object(host, 'child', return_value=json.dumps({'apiVersion':'ingestron.source-access-result/v1','status':'succeeded','action':'test'})) as child:
                result = host.execute(request)
                self.assertEqual(result['status'], 'succeeded')
                self.assertEqual(child.call_count,2)
                self.assertIn('inventory',child.call_args_list[0].args[0][2])
                (root / 'source_access.py').write_text('changed')
                with self.assertRaisesRegex(ValueError,'digest'): host.execute(request)
                self.assertEqual(environment.call_count,1)

    def test_preparation_never_invokes_the_source_and_unsafe_entry_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); request = self.fixture(root)
            spec = json.loads((root / 'source-access.json').read_text()); spec['action']='prepare'
            (root / 'source-access.json').write_text(json.dumps(spec))
            with patch.object(host,'environment',return_value=('python','fixture',True)) as environment,patch.object(host,'child') as child:
                result=host.execute(request);child.assert_not_called();self.assertTrue(environment.call_args.args[-1]);self.assertTrue(result['result']['reused'])
                spec['entryPoint']='../outside.py';(root/'source-access.json').write_text(json.dumps(spec))
                with self.assertRaises(ValueError): host.execute(request)

    def test_sample_host_rejects_excess_rows_and_action_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();request=self.fixture(root)
            spec=json.loads((root/'source-access.json').read_text());spec.update(action='sample',limit=1)
            (root/'source-access.json').write_text(json.dumps(spec))
            result={'apiVersion':'ingestron.source-access-result/v1','status':'succeeded','action':'sample','sample':{'columns':['id'],'rows':[[1]],'truncated':True}}
            with patch.object(host,'environment',return_value=('python','fixture',True)),patch.object(host,'child',side_effect=lambda *a:json.dumps(result)):
                self.assertEqual(host.execute(request)['result']['sample']['rows'],[[1]])
                result['sample']['rows'].append([2])
                with self.assertRaisesRegex(ValueError,'bounds'):host.execute(request)
                result['action']='metadata'
                with self.assertRaisesRegex(ValueError,'response'):host.execute(request)
