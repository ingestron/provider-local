import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('executor',Path(__file__).parents[1]/'src/execution.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Execution(unittest.TestCase):
    def test_rediscovery_archives_evidence_and_requires_fresh_review(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=root/'flows/sample';folder.mkdir(parents=True)
            cache=root/'cache'
            (root/'project-runtime.json').write_text(json.dumps({
                'flows':{'sample':{'directory':'flows/sample','runtime':'local'}},
                'environments':{'local':{}}}))
            (folder/'connector.json').write_text('{}')
            (folder/'discovery.json').write_text('{"old":true}')
            (folder/'review.json').write_text('{"status":"approved"}')
            request={'apiVersion':'ingestron.execution-request/v1','flows':['sample'],
                     'cache':str(cache),'action':'discover'}
            def child(args,*unused):
                if '--output' in args:
                    Path(args[args.index('--output')+1]).write_text('{"new":true}')
                    return '{"status":"Succeeded"}'
                return ''
            with (patch.object(module,'__file__',str(root/'execute.py')),
                  patch.object(module,'environment',return_value=('python','key',True)),
                  patch.object(module,'child',side_effect=child)):
                result=module.execute(request)
            self.assertEqual(result['status'],'succeeded')
            self.assertEqual(json.loads((folder/'discovery.json').read_text()),{'new':True})
            self.assertFalse((folder/'review.json').exists())
            self.assertEqual(len(list((folder/'history').glob('*.json'))),2)

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
        for code,expected in [('SQL_CONNECT','Cannot connect to SQL'),('SQL_TABLE','metadata is not visible'),('SQL_READ','SQL read failed'),('DB_CONNECT','Cannot connect to the database'),('DB_TABLE','metadata is not visible'),('GITHUB_AUTH','rejected the supplied token'),('GITHUB_RATE_LIMIT','rate limit'),('STRIPE_AUTH','Source error STRIPE_AUTH; see the connector documentation'),('GRAPH_NOT_FOUND','Source error GRAPH_NOT_FOUND'),('lower_case','Runtime operation failed'),('A'*50,'Runtime operation failed'),('unknown','Runtime operation failed')]:
            payload=json.dumps({'errorCode':code,'error':'sensitive-token-source-data'})
            with self.assertRaises(ValueError) as caught:
                module.child([sys.executable,'-c','import sys;print('+repr(payload)+');sys.exit(1)'],Path.cwd())
            self.assertIn(expected,str(caught.exception))
            self.assertNotIn('sensitive',str(caught.exception))

    def test_quality_failures_report_rule_identities_and_counts_only(self):
        import sys
        payload=json.dumps({'errorCode':'QUALITY_FAILED','error':'sensitive-row','failed':[
            {'id':'orders.key-unique','stream':'orders','metric':'duplicateValues','value':2},
            {'id':'bad id <sensitive-value>','value':'sensitive-text'}]})
        with self.assertRaises(ValueError) as caught:
            module.child([sys.executable,'-c','import sys;print('+repr(payload)+');sys.exit(1)'],Path.cwd())
        message=str(caught.exception)
        self.assertIn('nothing was committed: orders.key-unique (2), bad_id__sensitive-value_',message)
        self.assertNotIn('sensitive-text',message)
        self.assertNotIn('sensitive-row',message)
