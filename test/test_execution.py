import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('executor',Path(__file__).parents[1]/'src/execution.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Execution(unittest.TestCase):
    def test_path_and_cache_lock_safety(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaises(ValueError):module.inside(root,'../outside')
            (root/'link').symlink_to('/tmp')
            with self.assertRaises(ValueError):module.inside(root,'link/file')
            with module.locked(root/'guard'):
                with self.assertRaises(ValueError):
                    with module.locked(root/'guard'):pass

    def test_environment_prepare_reuses_exact_lock_and_failure_cleans_up(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);cache=root/'cache';cache.mkdir()
            (root/'requirements').write_text('example==1.0 ; sys_platform == \'linux\' \\\n    --hash=sha256:'+'a'*64+'\n')
            (root/'tools').write_text('# empty tools fixture\n')
            info={'requirements':'requirements','buildTools':'tools'}
            with self.assertRaisesRegex(ValueError,'not prepared'):module.environment(root,info,cache,{})
            calls=[]
            def child(args,*unused,**kwargs):
                calls.append(args)
                if 'venv' in args:
                    folder=Path(args[-1]);(folder/'bin').mkdir(parents=True);(folder/'bin/python').write_text('fixture')
                return ''
            with patch.object(module,'bootstrap',return_value=('/python','3.12.10')),patch.object(module,'child',side_effect=child):
                first=module.environment(root,info,cache,{},True)
                second=module.environment(root,info,cache,{},True)
            self.assertFalse(first[2]);self.assertTrue(second[2]);self.assertEqual(first[:2],second[:2])
            self.assertEqual(sum('venv' in c for c in calls),1)
            for c in calls[1:]:self.assertIn('--require-hashes',c);self.assertIn('--no-build-isolation',c)
            (root/'requirements').write_text('--extra-index-url https://unreviewed.invalid\n')
            with patch.object(module,'bootstrap',return_value=('/python','3.12.10')),patch.object(module,'child',side_effect=child):
                with self.assertRaisesRegex(ValueError,'lock syntax'):module.environment(root,info,cache,{},True)
            self.assertEqual(len(list(cache.glob('*/ready.json'))),1)



    def test_source_errors_are_allowlisted_and_do_not_echo_messages(self):
        import sys
        for code,expected in [('GITHUB_AUTH','rejected the supplied token'),('GITHUB_RATE_LIMIT','rate limit'),('unknown','Runtime operation failed')]:
            payload=json.dumps({'errorCode':code,'error':'sensitive-token-source-data'})
            with self.assertRaises(ValueError) as caught:
                module.child([sys.executable,'-c','import sys;print('+repr(payload)+');sys.exit(1)'],Path.cwd())
            self.assertIn(expected,str(caught.exception))
            self.assertNotIn('sensitive',str(caught.exception))
