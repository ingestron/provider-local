from pathlib import Path
import json, hashlib, subprocess, sys
b=Path(sys.argv[1]).resolve()
x=json.loads((b/'outputs/compact-review-metadata-limit-v2.json').read_text())
assert x['status']=='passed'
r=Path(x['details']['root']);j=x['details']['failedJob']
assert j['error'].startswith('SOURCE_METADATA_LIMIT: This flow exceeds')
st=j['result']['stages'];assert st[-1]['action']=='review' and st[-1]['status']=='failed'
assert all(s['status']=='succeeded' for s in st[:-1])
run=st[-1]['result']['id'];acks=[]
for p in (r/'.ingestron/runtimes/.ingestron-operation-receipts').rglob('acknowledgement.json'):
 a=json.loads(p.read_text())
 if a['id']==run:
  assert a['result']['errorCode']=='SOURCE_METADATA_LIMIT'
  assert 'message' not in a['result'] and a['result']['status']=='failed'
  acks.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'code':a['result']['errorCode'],'noUpstreamMessage':True})
assert len(acks)==1
folder=r/'build/studio/dev/flow_files/flows/flow_files'
assert not (folder/'review.json').exists()
# Count managed build output, excluding dependency packages' own test files.
assert not list((r/'build').rglob('*.parquet'))
assert not list((r/'build').rglob('*.approved.tmp'))
assert not list(folder.glob('*.staged*'))
assert all(json.loads(p.read_text())['status']!='running' for p in (r/'.ingestron/studio-jobs').glob('*.json'))
py=next(s['result']['result']['flows'][0]['python'] for s in st if s['operation']=='runtime_prepare')
script="import sys,json;sys.path.insert(0,sys.argv[1]);import singer_runtime;r=singer_runtime.workflow;from pathlib import Path;f=Path(sys.argv[1]);config=r.load(f/'connector.json');d=r.load(f/'discovery.json');review=r.review(d,r.load(f/'selection.json'),r.project_contracts(config['projectLock']));print(json.dumps({'encodedReviewBytes':len((r.canonical(review)+'\\n').encode()),'configBytes':(f/'connector.json').stat().st_size,'projectLockBytes':(f/'project-connection.lock.json').stat().st_size}))"
p=subprocess.run([py,'-I','-c',script,str(folder)],text=True,capture_output=True)
assert p.returncode==0,p.stderr
m=json.loads(p.stdout);assert m['encodedReviewBytes']>2000000
assert m['configBytes']<2000000 and m['projectLockBytes']<2000000
proof={'result':'passed','root':str(r),'candidate':x['details']['candidate'],'error':j['error'],'failedAction':'review','measurements':m,'reviewNotPublished':True,'managedParquetNotPublished':True,'temporaryReviewRemoved':True,'allJobsTerminal':True,'acknowledgements':acks,'scope':'Actual installed source workflow through provider durable acknowledgement and frozen Studio host; no browser interaction'}
(b/'outputs/compact-review-metadata-limit-qualified-v2.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(m))
