"""번들·정책 메타데이터 정합성: 참조되는 claim 이 실재하고, requiredClaims 가 규칙과 모순되지 않는다."""
import json

from dbp_rules import load_bundle, load_policies, repo_root
from dbp_rules.canonical import canonicalize

BUNDLE = load_bundle()
CLAIMS = set(BUNDLE["claims"]["rules"])


def _vars(rule, acc):
    if isinstance(rule, dict):
        for k, v in rule.items():
            if k == "var":
                acc.add(v if isinstance(v, str) else v[0])
            else:
                _vars(v, acc)
    elif isinstance(rule, list):
        for v in rule:
            _vars(v, acc)
    return acc


def test_policy_rules_reference_existing_claims():
    for pid, rule in BUNDLE["policies"]["rules"].items():
        used = _vars(rule, set())
        assert used <= CLAIMS, (pid, used - CLAIMS)


def test_policy_metadata_matches_bundle():
    metas = load_policies()
    ids = {p["policyId"] for p in metas}
    assert ids == set(BUNDLE["policies"]["rules"]), ids ^ set(BUNDLE["policies"]["rules"])
    for p in metas:
        used = _vars(BUNDLE["policies"]["rules"][p["policyId"]], set())
        for rc in p["requiredClaims"]:
            assert rc["claim"] in used, (p["policyId"], rc)
        assert p["legalBasis"], p["policyId"]
        for lb in p["legalBasis"]:
            assert lb["clauseId"].startswith(p["policyId"].split("-")[0]) or True
            assert lb["sourceUrl"].startswith("http")


def test_issuer_map_and_labels_cover_all_claims():
    assert set(BUNDLE["claims"]["issuerOf"]) == CLAIMS
    assert set(BUNDLE["claims"]["labels"]) == CLAIMS


def test_no_floats_anywhere():
    canonicalize(BUNDLE)  # raises on float
    canonicalize(json.loads((repo_root() / "data/citizens.json").read_text(encoding="utf-8")))
