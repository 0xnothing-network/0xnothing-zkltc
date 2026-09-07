from pathlib import Path
import sys, json, hashlib
sys.stdout.reconfigure(encoding='utf-8')

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
kind, operation = sys.argv[1:3]
ledger_path = OUT / f'{kind}-reviewed.json'
ledger = json.loads(ledger_path.read_text(encoding='utf-8'))
for selector in sys.argv[3:]:
    parts = selector.split(':')
    index = int(parts[0])
    entry = ledger['files'][index]
    data = (ROOT / entry['path']).read_bytes()
    lines = data.decode('utf-8-sig').splitlines()
    start = int(parts[1]) if len(parts)>1 else 1
    end = int(parts[2]) if len(parts)>2 else len(lines)
    if operation == 'read':
        print(f'FILE {index} {entry["path"]} L{start}-{end}/{len(lines)}')
        for lineno in range(start, min(end, len(lines))+1):
            print(f'{lineno}: {lines[lineno-1]}')
    elif operation == 'confirm':
        spans = entry.setdefault('reviewed_line_ranges', [])
        spans.append([start, min(end, len(lines))])
        covered = set(n for a,b in spans for n in range(a,b+1))
        complete = len(covered) == len(lines)
        entry['read_status'] = 'fully_read' if complete else 'partially_read'
        entry['current_sha256'] = hashlib.sha256(data).hexdigest()
        entry['unchanged_from_inventory'] = entry['sha256'] == entry['current_sha256']
        print(index, entry['read_status'], len(covered), '/', len(lines))
    else:
        raise ValueError(operation)
if operation == 'confirm':
    ledger_path.write_text(json.dumps(ledger, indent=2)+'\n', encoding='utf-8')
