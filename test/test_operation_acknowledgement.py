"""Actual parent termination and durable finaliser acknowledgement on POSIX."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).parents[1] / 'src/execution.py'
FIXTURE = '''
def execute(request):
    folder = Path(request['cache'])
    marker = folder / (request['action'] + '-started')
    marker.write_text(str(os.getpid()))
    while not (folder / 'release').exists():
        import time
        time.sleep(0.01)
    counter = folder / 'executions'
    counter.write_text(counter.read_text() + '1' if counter.exists() else '1')
    if (folder / 'fail').exists():
        raise ValueError('private source detail')
    return {'apiVersion': 'ingestron.execution-result/v1', 'status': 'succeeded',
            'action': request['action'], 'flows': [{'flow': flow, 'status': 'Succeeded'} for flow in request['flows']]}

'''


class OperationAcknowledgement(unittest.TestCase):
    def invoke(self, entry, request):
        completed = subprocess.run([sys.executable, str(entry)], input=json.dumps(request),
                                   text=True, capture_output=True, timeout=10)
        return json.loads(completed.stdout)

    def wait_for(self, path):
        deadline = time.monotonic() + 10
        while not path.exists():
            if time.monotonic() > deadline:
                self.fail('Owned fixture did not reach its acknowledgement barrier')
            time.sleep(0.01)

    def test_each_setup_finaliser_survives_parent_and_acknowledges_without_replay(self):
        for action in ('prepare', 'catalogue', 'discover', 'review', 'approve', 'checkpoint_preview', 'checkpoint_apply'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                entry = root / 'execute.py'
                entry.write_text(SOURCE.read_text().replace('SETUP_ACTIONS =', FIXTURE + 'SETUP_ACTIONS =', 1))
                cache = root / 'cache'
                cache.mkdir()
                request = {'apiVersion': 'ingestron.execution-request/v1', 'action': action,
                           'runId': '9-original', 'flows': ['orders'], 'fingerprint': 'a' * 64, 'cache': str(cache)}
                parent = subprocess.Popen([sys.executable, str(entry)], stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                worker = None
                worker_birth = None
                try:
                    parent.stdin.write(json.dumps(request))
                    parent.stdin.close()
                    self.wait_for(cache / (action + '-started'))
                    worker = int((cache / (action + '-started')).read_text())
                    worker_birth = subprocess.check_output(['ps', '-p', str(worker), '-o', 'lstart='], text=True).strip()
                    os.kill(parent.pid, signal.SIGKILL)
                    parent.wait(timeout=10)
                    ack = {**request, 'action': 'acknowledge', 'originalAction': action}
                    self.assertEqual(self.invoke(entry, ack)['status'], 'interrupted')
                    os.kill(worker, 0)
                    (cache / 'release').write_text('complete original operation')
                    receipt = cache / '.ingestron-operation-receipts' / ('a' * 64) / '9-original' / 'acknowledgement.json'
                    self.wait_for(receipt)
                    recovered = self.invoke(entry, ack)
                    self.assertEqual(recovered['status'], 'succeeded')
                    self.assertEqual(recovered['acknowledgement']['result']['status'], 'succeeded')
                    self.assertEqual(self.invoke(entry, request)['status'], 'succeeded')
                    self.assertEqual((cache / 'executions').read_text(), '1')
                    for change in ({'originalAction': 'approve' if action != 'approve' else 'review'},
                                   {'flows': ['foreign']}, {'fingerprint': 'b' * 64}):
                        self.assertEqual(self.invoke(entry, {**ack, **change})['status'], 'interrupted')
                    self.assertEqual((cache / 'executions').read_text(), '1')
                finally:
                    if parent.poll() is None:
                        parent.kill()
                        parent.wait(timeout=10)
                    if worker:
                        # Only this fixture's independently owned operation worker.
                        try:
                            command = subprocess.check_output(['ps', '-p', str(worker), '-o', 'command='], text=True, stderr=subprocess.DEVNULL).strip()
                            birth = subprocess.check_output(['ps', '-p', str(worker), '-o', 'lstart='], text=True, stderr=subprocess.DEVNULL).strip()
                            if str(entry) in command and '--operation-worker' in command and birth == worker_birth:
                                os.kill(worker, signal.SIGTERM)
                        except (ProcessLookupError, subprocess.CalledProcessError):
                            pass
                    parent.stdout.close()
                    parent.stderr.close()

    def test_confirmed_failure_is_durable_bounded_and_never_reexecuted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            entry = root / 'execute.py'
            entry.write_text(SOURCE.read_text().replace('SETUP_ACTIONS =', FIXTURE + 'SETUP_ACTIONS =', 1))
            cache = root / 'cache'
            cache.mkdir()
            (cache / 'release').write_text('ready')
            (cache / 'fail').write_text('known failure')
            request = {'apiVersion': 'ingestron.execution-request/v1', 'action': 'review',
                       'runId': 'original', 'flows': ['orders'], 'fingerprint': 'a' * 64, 'cache': str(cache)}
            self.assertEqual(self.invoke(entry, request)['status'], 'failed')
            ack = self.invoke(entry, {**request, 'action': 'acknowledge', 'originalAction': 'review'})
            self.assertEqual(ack['acknowledgement']['result']['status'], 'failed')
            self.assertNotIn('private source detail', json.dumps(ack))
            self.assertEqual((cache / 'executions').read_text(), '1')

    def test_symlink_or_foreign_journal_does_not_authorise_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            entry = root / 'execute.py'
            entry.write_text(SOURCE.read_text())
            cache = root / 'cache'
            cache.mkdir()
            (cache / '.ingestron-operation-receipts').symlink_to(root)
            request = {'apiVersion': 'ingestron.execution-request/v1', 'action': 'acknowledge',
                       'originalAction': 'prepare', 'runId': '../foreign', 'flows': ['orders'],
                       'fingerprint': 'a' * 64, 'cache': str(cache)}
            for run_id in ('../foreign', 'original'):
                request['runId'] = run_id
                self.assertEqual(self.invoke(entry, request)['status'], 'interrupted')
