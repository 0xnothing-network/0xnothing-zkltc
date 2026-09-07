import collections
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent


def finalize(name: str) -> dict:
    path = OUT / f"{name}-reviewed.json"
    ledger = json.loads(path.read_text(encoding="utf-8"))
    parsed_json = []
    for entry in ledger["files"]:
        assert entry["read_status"] == "fully_read", entry["path"]
        covered = set()
        for start, end in entry["reviewed_line_ranges"]:
            covered.update(range(start, end + 1))
        assert covered >= set(range(1, entry["lines"] + 1)), entry["path"]
        source = ROOT / entry["path"]
        raw = source.read_bytes()
        current_sha = hashlib.sha256(raw).hexdigest()
        entry["current_sha256"] = current_sha
        entry["current_bytes"] = len(raw)
        entry["current_lines"] = len(raw.decode("utf-8-sig").splitlines())
        entry["unchanged_from_inventory"] = current_sha == entry["sha256"]
        if not entry["unchanged_from_inventory"]:
            assert name == "docs-config" and entry["path"] == "package.json", entry["path"]
            package = json.loads(raw)
            scripts = package["scripts"]
            assert scripts["check:pixel-subgraph"] == "npm --prefix 0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace run check"
            assert "npm run check:pixel-subgraph" in scripts["verify"]
            assert "npm run build:pixel-subgraph" not in scripts["verify"]
            entry["parent_change_reviewed"] = {
                "method": "Baseline was read in full; the exact git diff was reviewed after the parent added marketplace check to root verify.",
                "change": "Added check:pixel-subgraph and replaced build:pixel-subgraph with check:pixel-subgraph in verify.",
                "baseline_lines": entry["lines"],
                "current_lines": entry["current_lines"],
                "root_verify_executed_by_this_agent": False,
            }
        if source.suffix == ".json":
            json.loads(raw)
            parsed_json.append(entry["path"])
    ledger["summary"] = {
        "review_date": "2026-09-07",
        "files": len(ledger["files"]),
        "baseline_lines": sum(e["lines"] for e in ledger["files"]),
        "current_lines": sum(e["current_lines"] for e in ledger["files"]),
        "baseline_bytes": sum(e["bytes"] for e in ledger["files"]),
        "read_status_counts": dict(collections.Counter(e["read_status"] for e in ledger["files"])),
        "pending": 0,
        "source_edits_by_this_agent": 0,
        "unchanged_from_inventory": sum(e["unchanged_from_inventory"] for e in ledger["files"]),
        "coverage_basis": "Complete source reads with explicit line ranges; inventory hashes preserved and current hashes rechecked.",
    }
    if name == "styles":
        ledger["review"] = {
            "areas": ["cascade", "selector scope", "responsive breakpoints", "overflow", "sizing", "focus", "disabled states", "reduced motion"],
            "finding": "No actionable layout defect established by source review; all eight CSS files preserved byte for byte.",
            "validation": {"parser": "existing apps/web PostCSS", "files_parsed": 8, "exit_code": 0, "log": "styles-parse.log"},
            "limit": "Source review and syntax parsing do not establish rendered browser layout correctness. No visual/browser validation performed by this agent.",
        }
    else:
        ledger["review"] = {
            "finding": "Root verify built marketplace subgraph but omitted its new regression tests; parent integrated check:pixel-subgraph and the exact diff was reviewed.",
            "resolved_by": "parent",
            "json_syntax_validation": {"files": parsed_json, "exit_code": 0},
            "limits": ["Deployment records and readiness claims reviewed as repository records; no live chain or external deployment verification.", "Only the empty .env.example was read; private.env and real credential files were not read.", "No root verify execution by this agent."],
        }
    path.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(name, json.dumps(ledger["summary"], ensure_ascii=False))
    if parsed_json:
        print("JSON_PARSED", len(parsed_json))
    return ledger


styles = finalize("styles")
docs = finalize("docs-config")

(OUT / "styles-report.md").write_text("""# Web stylesheet audit — 2026-09-07

All eight assigned web CSS files were read in full: 0xFi/globals.css, 0xFi/shared.css, 0xPump/globals.css, 0xpixel/globals.css, dev/dev.module.css, docs/docs.css, app/globals.css and app/home.css. The wallet stylesheet belongs to the wallet audit and is not included here.

The review covers 11,892 lines, with exact reviewed ranges and SHA-256 evidence in styles-reviewed.json. Cascade, selector scope, breakpoints, overflow, sizing, focus, disabled states and reduced-motion behavior were reviewed. No actionable layout defect was established by the source review. All eight stylesheets remain byte-identical to their audit inventory.

The existing app PostCSS parser successfully parsed all eight files. styles-parse.log records per-file rule/declaration counts and EXIT_CODE=0. This is syntax validation, not browser rendering validation. No CSS edits or visual/browser validation were performed by this agent.
""", encoding="utf-8")

(OUT / "docs-config-report.md").write_text("""# Root, deployment and protocol documentation/config audit — 2026-09-07

All 32 assigned files were read in full, covering 2,303 baseline lines across root instructions/ignore files/package scripts/testing docs, Mainnet root/release/config/deployment/docs/script/test records, Testnet root/config/deployment/docs, and 0xFi root/config/docs. docs-config-reviewed.json records exact reviewed ranges, original hashes and current hashes. No assigned files remain pending. All scoped JSON files also parse successfully.

The root verify script originally built the marketplace subgraph without executing its new regression tests. The finding was sent to the parent, who added check:pixel-subgraph and made verify invoke it. The exact parent diff was reviewed and recorded separately from the original full-file read. The current root package has one additional line; all other assigned files are unchanged from their inventory. This agent made no source edits in the CSS/docs/config extension scope and did not execute root verify.

Deployment JSON, activation/configuration policy and readiness statements were reviewed as repository records. They do not establish present chain state or live deployment readiness. No external links or chain state were verified in this bounded audit. Only the empty .env.example was inspected; real private environment/credential files were not read. Vendored libraries are excluded from this coverage and remain reported separately in contracts-vendor-hashes.json.
""", encoding="utf-8")
print("EXIT_CODE=0")
