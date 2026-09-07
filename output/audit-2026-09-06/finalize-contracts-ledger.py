from pathlib import Path
from collections import Counter, defaultdict
import hashlib
import json
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).parent
ledger_path = OUT / 'contracts-reviewed.json'
ledger = json.loads(ledger_path.read_text(encoding='utf-8'))
locks = []
for entry in ledger['files']:
    path = ROOT / entry['path']
    entry['current_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    if entry['category'] != 'first_party' or path.name != 'package-lock.json':
        continue
    lock = json.loads(path.read_text(encoding='utf-8'))
    package = json.loads(path.with_name('package.json').read_text(encoding='utf-8'))
    packages = lock['packages']
    dependencies = ('dependencies', 'devDependencies', 'optionalDependencies')
    mismatches = [key for key in dependencies if package.get(key, {}) != packages[''].get(key, {})]
    hosts = Counter()
    missing_integrity = []
    for name, resolved_package in packages.items():
        if not name:
            continue
        url = urlsplit(resolved_package.get('resolved', ''))
        hosts[f'{url.scheme}://{url.hostname}'] += 1
        if not resolved_package.get('integrity') and not resolved_package.get('link'):
            missing_integrity.append(name)
    locks.append(dict(path=entry['path'], sha256=entry['current_sha256'], lockfileVersion=lock['lockfileVersion'],
                      packagesIncludingRoot=len(packages), rootPackage=packages[''], resolutionHosts=dict(hosts),
                      rootDependencyMismatches=mismatches, missingIntegrity=missing_integrity))
    entry['read_status'] = 'structured_data_reviewed'
    entry['semantic_review'] = 'all_JSON_entries_parsed_and_dependency_resolution_metadata_checked'
    entry['review_evidence'] = 'contracts-lockfiles-review.json; not a line-by-line semantic dependency audit'

known_paths = {entry['path'] for entry in ledger['files']}
for relative in [
    '0xNothing-zkLTC-Testnet/contracts/test/unit/MathX.t.sol',
    '0xNothing-zkLTC-Mainnet/contracts/test/unit/MathX.t.sol',
    '0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace/tests/mapping.test.mjs',
]:
    if relative in known_paths:
        continue
    data = (ROOT / relative).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    ledger['files'].append(dict(path=relative, bytes=len(data), sha256=digest, current_sha256=digest,
                               category='first_party', inventory_origin='authored_during_audit',
                               read_status='authored_and_reviewed', semantic_review='reviewed_and_tested'))

vendor_groups = defaultdict(list)
vendor_sections = Counter()
for entry in ledger['files']:
    if entry['category'] != 'vendor':
        continue
    vendor_groups[entry['current_sha256']].append(entry['path'])
    remainder = entry['path'].split('/openzeppelin-contracts/', 1)[1]
    vendor_sections[remainder.split('/', 1)[0] if '/' in remainder else '[root files]'] += 1
vendor_evidence = dict(files=898, uniqueHashes=len(vendor_groups), bytes=sum(e['bytes'] for e in ledger['files'] if e['category']=='vendor'),
                       semanticReview='not performed', sections=dict(vendor_sections),
                       hashGroups=[dict(sha256=digest, canonical=paths[0], equivalentPaths=paths[1:]) for digest, paths in sorted(vendor_groups.items())])
ledger['coverage_notes'] = dict(baseline_first_party=213, baseline_vendor=898, added_first_party=3,
                               first_party_review_complete=True, vendor_semantic_review_complete=False,
                               structured_data_is_not_line_by_line_source_read=True,
                               baseline_sha256_preserved=True, current_sha256_recorded=True)
ledger['validation'] = [
    dict(command='forge test', scope='0xNothing-zkLTC-Testnet/contracts', exitCode=0, passed=70, suites=12, log='testnet-contracts-tests.log', exitEvidence='captured tool result in audit session'),
    dict(command='forge test', scope='0xNothing-zkLTC-Mainnet/contracts', exitCode=0, passed=72, suites=12, log='mainnet-contracts-tests.log', exitEvidence='captured tool result in audit session'),
    dict(command='forge test', scope='0xNothing-zkLTC-Testnet/0xFi/contracts', exitCode=0, passed=142, suites=15, log='fi-contracts-tests.log', exitEvidence='captured tool result in audit session'),
    dict(command='npm run check', scope='0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace', exitCode=0, passed=4, log='marketplace-after.log', exitEvidence='EXIT_CODE=0 marker in log; Node mapping model regressions plus Graph codegen/build'),
    dict(command='forge fmt --check src/common/MathX.sol test/unit/MathX.t.sol', scope='both Testnet/contracts and Mainnet/contracts', exitCode=0, exitEvidence='captured tool result 2026-09-07'),
    dict(command='forge fmt --check src/lending/PooledNUSDLendingPool.sol test/risk/PooledNUSDLendingPool.t.sol', scope='Testnet/0xFi/contracts', exitCode=0, exitEvidence='captured tool result 2026-09-07 after two test-line formatting corrections'),
]
for name, document in [('contracts-reviewed.json', ledger), ('contracts-lockfiles-review.json', locks), ('contracts-vendor-hashes.json', vendor_evidence)]:
    (OUT / name).write_text(json.dumps(document, indent=2) + '\n', encoding='utf-8')
print(json.dumps(dict(firstPartyStatus=Counter(e['read_status'] for e in ledger['files'] if e['category']=='first_party'),
                      vendorStatus=Counter(e['read_status'] for e in ledger['files'] if e['category']=='vendor'),
                      vendorUniqueHashes=len(vendor_groups), vendorSections=dict(vendor_sections)), indent=2))
