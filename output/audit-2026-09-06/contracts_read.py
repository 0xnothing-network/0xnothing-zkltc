from pathlib import Path
import json, hashlib, sys, os

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).parent
LEDGER = OUT / 'contracts-reviewed.json'
SCOPES = ['0xNothing-zkLTC-Testnet/contracts','0xNothing-zkLTC-Mainnet/contracts','0xNothing-zkLTC-Testnet/0xFi/contracts','0xNothing-zkLTC-Testnet/subgraphs','0xNothing-zkLTC-Mainnet/subgraphs','0xNothing-zkLTC-Testnet/0xFi/subgraph']
EXCLUDED = {'out','cache','broadcast','node_modules','generated','build','.git'}

def inventory():
    files=[]
    for scope in SCOPES:
        collected=[]
        for directory, dirs, names in os.walk(ROOT/scope):
            dirs[:]=[d for d in dirs if d not in EXCLUDED]
            collected.extend(Path(directory)/name for name in names)
        for p in sorted(collected):
            rel=p.relative_to(ROOT).as_posix()
            if any(x in EXCLUDED for x in p.relative_to(ROOT/scope).parts): continue
            data=p.read_bytes()
            vendor='/contracts/lib/' in rel
            files.append(dict(path=rel,bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),category='vendor' if vendor else 'first_party',read_status='pending',semantic_review='pending'))
    LEDGER.write_text(json.dumps(dict(scopes=SCOPES,excluded_generated_dirs=sorted(EXCLUDED),files=files),indent=2),encoding='utf-8')

if not LEDGER.exists(): inventory()
ledger=json.loads(LEDGER.read_text(encoding='utf-8'))
if sys.argv[1]=='inventory':
    groups={}
    for f in ledger['files']:
        key=f['category']; groups[key]=groups.get(key,0)+1
    print(json.dumps(groups))
    for i,f in enumerate(ledger['files']):
        if f['category']=='first_party': print(i,f['bytes'],f['path'])
elif sys.argv[1]=='read':
    for i in map(int,sys.argv[2:]):
        f=ledger['files'][i]; p=ROOT/f['path']; text=p.read_text(encoding='utf-8-sig')
        print('\nFILE',i,f['path'])
        for n,line in enumerate(text.splitlines(),1): print(f'{n}: {line}')
        f['read_status']='printed_full_pending_confirmation'
    LEDGER.write_text(json.dumps(ledger,indent=2),encoding='utf-8')
elif sys.argv[1]=='confirm':
    for i in map(int,sys.argv[2:]):
        f=ledger['files'][i]; f['read_status']='fully_read'; f['semantic_review']='reviewed'
    LEDGER.write_text(json.dumps(ledger,indent=2),encoding='utf-8')
elif sys.argv[1]=='equivalents':
    reviewed={}
    for f in ledger['files']:
        if f['read_status']=='fully_read':
            actual=hashlib.sha256((ROOT/f['path']).read_bytes()).hexdigest()
            reviewed[actual]=f['path']
    for f in ledger['files']:
        if f['category']!='first_party' or f['read_status']=='fully_read': continue
        actual=hashlib.sha256((ROOT/f['path']).read_bytes()).hexdigest()
        if actual in reviewed:
            f['read_status']='hash_equivalent_to_fully_read'
            f['semantic_review']='identical_bytes_reviewed_via_reference'
            f['review_reference']=reviewed[actual]
            print(f['path'],'==',reviewed[actual])
    LEDGER.write_text(json.dumps(ledger,indent=2),encoding='utf-8')
