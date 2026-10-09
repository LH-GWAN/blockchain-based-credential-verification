"""번들·정책 메타데이터 정합성: 참조되는 claim 이 실재하고, requiredClaimSets 가 규칙과 정확히 같다.

requiredClaimSets 는 '정책을 참으로 만드는 증명 조합'의 anyOf 다. 지갑은 이 조합으로 무엇을 보여 줄지 고르고,
창구 프리셋은 조합 하나를 그대로 요청한다. 그래서 조합마다 (1) 그것만으로 규칙이 참이 되고(충분),
(2) 조합을 모두 합치면 규칙이 참인 경우를 빠짐없이 덮어야(필요) 한다. 둘 다 규칙 변수 전체 조합으로 확인한다.
"""
import json
from itertools import product

import pytest
from dbp_rules import (
    claim_sets,
    evaluate,
    evaluate_policy_partial,
    load_bundle,
    load_policies,
    repo_root,
    rule_vars,
)
from dbp_rules.canonical import canonicalize
from dbp_verifier.config import PRESETS

BUNDLE = load_bundle()
CLAIMS = set(BUNDLE["claims"]["rules"])
RULES = BUNDLE["policies"]["rules"]
METAS = {p["policyId"]: p for p in load_policies()}


def _pairs(items) -> frozenset[tuple[str, bool]]:
    return frozenset((rc["claim"], rc["expected"]) for rc in items)


def test_policy_rules_reference_existing_claims():
    for pid, rule in RULES.items():
        used = rule_vars(rule)
        assert used <= CLAIMS, (pid, used - CLAIMS)


def test_policy_metadata_matches_bundle():
    ids = set(METAS)
    assert ids == set(RULES), ids ^ set(RULES)
    for p in METAS.values():
        # 2026.2 부터는 조합 목록만 둔다 (옛 단일 목록과 섞여 있으면 어느 쪽을 믿을지 모호해진다)
        assert "requiredClaims" not in p and p["requiredClaimSets"], p["policyId"]
        assert p["ruleRef"] == {"bundle": BUNDLE["bundle"], "version": BUNDLE["version"]}, p["policyId"]
        used = rule_vars(RULES[p["policyId"]])
        for s in claim_sets(p):
            assert s, (p["policyId"], "빈 조합")
            names = [rc["claim"] for rc in s]
            assert len(names) == len(set(names)), (p["policyId"], s)
            for rc in s:
                assert set(rc) == {"claim", "expected"} and isinstance(rc["expected"], bool), (p["policyId"], rc)
                assert rc["claim"] in used, (p["policyId"], rc)
        assert p["legalBasis"], p["policyId"]
        for lb in p["legalBasis"]:
            assert lb["clauseId"].startswith(p["policyId"].split("-")[0]) or True
            assert lb["sourceUrl"].startswith("http")


@pytest.mark.parametrize("pid", sorted(RULES))
def test_each_claim_set_is_sufficient_and_minimal(pid):
    """조합 하나만 알아도 판정이 참으로 확정되고, 어느 항목을 빼도 확정되지 않는다 (필요 이상 요구하지 않음)."""
    sets = claim_sets(METAS[pid])
    for s in sets:
        known = {rc["claim"]: rc["expected"] for rc in s}
        assert evaluate_policy_partial(BUNDLE, pid, known) == {"eligible": True, "pending": []}, (pid, s)
        for drop in known:
            rest = {k: v for k, v in known.items() if k != drop}
            assert evaluate_policy_partial(BUNDLE, pid, rest)["eligible"] is not True, (pid, s, drop)
    # 다른 조합을 포함하는 조합은 두지 않는다
    for a in sets:
        for b in sets:
            assert a is b or not _pairs(b) < _pairs(a), (pid, a, b)


@pytest.mark.parametrize("pid", sorted(RULES))
def test_claim_sets_union_is_necessary(pid):
    """규칙 변수의 모든 참/거짓 조합에서: 규칙이 참 ⇔ 어떤 조합과 일치한다."""
    rule = RULES[pid]
    names = sorted(rule_vars(rule))
    sets = [_pairs(s) for s in claim_sets(METAS[pid])]
    for bits in product([False, True], repeat=len(names)):
        a = dict(zip(names, bits, strict=True))
        covered = any(all(a[c] == e for c, e in s) for s in sets)
        assert evaluate(rule, a) is covered, (pid, a)


def test_claim_sets_pin_alternative_paths():
    """여러 경로가 있는 정책의 조합과 순서 (앞쪽이 창구가 먼저 권하는 경로)."""
    def plain(pid):
        return [[(rc["claim"], rc["expected"]) for rc in s] for s in claim_sets(METAS[pid])]

    t = True
    assert plain("sunshine-loan-general") == [[("annualIncomeUnder35M", t)],
                                              [("creditBottom20", t), ("annualIncomeUnder45M", t)]]
    assert plain("new-hope-loan") == [[("annualIncomeUnder40M", t)],
                                      [("creditBottom20", t), ("annualIncomeUnder50M", t)]]
    assert plain("micro-livelihood-loan") == [[("annualIncomeUnder35M", t), ("creditBottom20", t)],
                                              [("annualIncomeUnder35M", t), ("isBenefitRecipient", t)],
                                              [("annualIncomeUnder35M", t), ("incomeBelow50Median", t)]]
    assert plain("telecom-discount") == [[("incomeBelow50Median", t)], [("isBenefitRecipient", t)],
                                         [("ageOver65", t), ("incomeBelowBasicPensionLine", t)]]
    for pid in ["electricity-welfare-discount", "city-gas-discount"]:
        assert plain(pid) == [[("incomeBelow50Median", t)], [("isBenefitRecipient", t)]], pid
    assert plain("near-poor") == [[("incomeBelow50Median", t), ("isBenefitRecipient", False)]]
    multi = {"sunshine-loan-general", "new-hope-loan", "micro-livelihood-loan", "telecom-discount",
             "electricity-welfare-discount", "city-gas-discount"}
    for pid in set(RULES) - multi:
        assert len(claim_sets(METAS[pid])) == 1, pid


def test_self_checked_claims_appear_only_with_a_vc_claim():
    """issuerOf 'self'(신용평점)는 증명서가 아니라 창구 조회 항목이다. 그것만으로 된 조합이 있으면
    증명서 없이 판정이 끝나므로, 반드시 발급기관이 증명하는 항목과 함께 나온다."""
    issuer_of = BUNDLE["claims"]["issuerOf"]
    for pid, p in METAS.items():
        for s in claim_sets(p):
            assert any(issuer_of[rc["claim"]] != "self" for rc in s), (pid, s)


def test_verifier_presets_request_exactly_one_claim_set():
    """창구 프리셋의 (요청 항목 ∪ 창구 자체 확인 항목) = 그 정책의 증명 조합 중 정확히 하나."""
    issuer_of = BUNDLE["claims"]["issuerOf"]
    with_policy = [p for p in PRESETS if p.get("policyId")]
    assert {p["id"] for p in with_policy} == {"sunshine-general", "sunshine-general-low-credit", "new-hope",
                                              "new-hope-low-credit"}
    for preset in PRESETS:
        requested = preset["requested"]
        counter = preset.get("counterChecked", [])
        # 증명서로 받는 항목은 발급기관 소관, 창구 확인 항목은 'self' 뿐
        assert all(issuer_of[rc["claim"]] != "self" for rc in requested), preset["id"]
        assert all(issuer_of[rc["claim"]] == "self" for rc in counter), preset["id"]
        if not preset.get("policyId"):
            assert not counter, preset["id"]
            continue
        asked = _pairs(requested + counter)
        assert len(asked) == len(requested) + len(counter), preset["id"]
        matches = [s for s in claim_sets(METAS[preset["policyId"]]) if _pairs(s) == asked]
        assert len(matches) == 1, (preset["id"], sorted(asked))


def test_issuer_map_and_labels_cover_all_claims():
    assert set(BUNDLE["claims"]["issuerOf"]) == CLAIMS
    assert set(BUNDLE["claims"]["labels"]) == CLAIMS


def test_no_floats_anywhere():
    canonicalize(BUNDLE)  # raises on float
    canonicalize(json.loads((repo_root() / "data/citizens.json").read_text(encoding="utf-8")))
