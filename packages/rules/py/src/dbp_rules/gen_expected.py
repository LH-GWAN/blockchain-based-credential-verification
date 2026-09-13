"""data/expected.json 생성: python -m dbp_rules.gen_expected"""
from __future__ import annotations

import json
from datetime import date

from .bundle import bundle_hash, load_bundle
from .engine import DEFAULT_EVAL_DATE
from .paths import repo_root
from .reference import reference_claims, reference_policies


def main() -> None:
    root = repo_root()
    median = json.loads((root / "data/median-income-2026.json").read_text(encoding="utf-8"))
    citizens = json.loads((root / "data/citizens.json").read_text(encoding="utf-8"))["citizens"]
    as_of = date.fromisoformat(DEFAULT_EVAL_DATE)
    b = load_bundle()
    rows = []
    for c in citizens:
        k = reference_claims(c, median["byHouseholdSize"], median["basicPension2026"], as_of)
        rows.append({"citizenId": c["citizenId"], "claims": k, "policies": reference_policies(k)})
    out = {
        "evalDate": DEFAULT_EVAL_DATE,
        "bundle": b["bundle"],
        "version": b["version"],
        "bundleHash": bundle_hash(b),
        "citizenCount": len(rows),
        "policyCount": len(b["policies"]["rules"]),
        "verdictCount": len(rows) * len(b["policies"]["rules"]),
        "rows": rows,
    }
    (root / "data/expected.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote data/expected.json: {out['citizenCount']} citizens x {out['policyCount']} policies = {out['verdictCount']} verdicts; bundleHash={out['bundleHash']}")


if __name__ == "__main__":
    main()
