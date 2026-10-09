"""부분 판정(evaluate_policy_partial): 제출된 claim 만으로 정책을 판정하고, 모르는 claim 을 거짓으로 채우지 않는다.

검증기관은 창구가 요청한 항목만 받는다. 예전 구현은 제출되지 않은 항목을 모두 거짓으로 채워서
수급자가 '중위소득 50% 이하' 하나만 내도 차상위계층(= 50% 이하 AND 수급자 아님)이 '적격'으로 보였다.
"""
import json
from datetime import date
from itertools import product

import pytest
from dbp_rules import (
    claim_sets,
    evaluate_claims,
    evaluate_policies,
    evaluate_policy_partial,
    load_bundle,
    repo_root,
    rule_vars,
)
from dbp_rules.reference import reference_policies

ROOT = repo_root()
BUNDLE = load_bundle()
RULES = BUNDLE["policies"]["rules"]
ALL_FALSE = {k: False for k in BUNDLE["claims"]["rules"]}


def test_rule_vars():
    assert rule_vars(RULES["near-poor"]) == {"incomeBelow50Median", "isBenefitRecipient"}
    assert rule_vars(RULES["sunshine-loan-general"]) == {"annualIncomeUnder35M", "creditBottom20", "annualIncomeUnder45M"}
    assert rule_vars({"var": ["x", False]}) == {"x"}
    assert rule_vars(True) == set()


def test_near_poor_with_only_income_is_pending_on_recipient():
    r = evaluate_policy_partial(BUNDLE, "near-poor", {"incomeBelow50Median": True})
    assert r == {"eligible": None, "pending": ["isBenefitRecipient"]}
    # 수급자임이 알려지면 확정적으로 부적격, 아님이 알려지면 적격
    assert evaluate_policy_partial(BUNDLE, "near-poor", {"incomeBelow50Median": True, "isBenefitRecipient": True}) \
        == {"eligible": False, "pending": []}
    assert evaluate_policy_partial(BUNDLE, "near-poor", {"incomeBelow50Median": True, "isBenefitRecipient": False}) \
        == {"eligible": True, "pending": []}
    # 소득이 기준을 넘으면 수급 여부와 무관하게 부적격
    assert evaluate_policy_partial(BUNDLE, "near-poor", {"incomeBelow50Median": False}) == {"eligible": False, "pending": []}


def test_sunshine_partial_paths():
    pid = "sunshine-loan-general"
    assert evaluate_policy_partial(BUNDLE, pid, {"annualIncomeUnder35M": True}) == {"eligible": True, "pending": []}
    r = evaluate_policy_partial(BUNDLE, pid, {"annualIncomeUnder45M": True})
    assert r["eligible"] is None and "creditBottom20" in r["pending"]
    assert evaluate_policy_partial(BUNDLE, pid, {"annualIncomeUnder45M": True, "creditBottom20": True}) \
        == {"eligible": True, "pending": []}
    # 아무것도 모르면 판정 보류, 결과를 바꿀 수 있는 항목은 셋 다
    r = evaluate_policy_partial(BUNDLE, pid, {})
    assert r["eligible"] is None and set(r["pending"]) == rule_vars(RULES[pid])


def test_known_values_outside_the_rule_are_ignored():
    r = evaluate_policy_partial(BUNDLE, "near-poor", {"incomeBelow50Median": True, "daeguResident": True})
    assert r == {"eligible": None, "pending": ["isBenefitRecipient"]}


def test_unknown_policy_is_not_judged():
    """규칙 묶음에 없는 정책은 판정하지 않는다(KeyError 대신 eligible=None)."""
    assert evaluate_policy_partial(BUNDLE, "sunshine-loan-bank", {"annualIncomeUnder35M": True}) == {"eligible": None, "pending": []}


def test_all_known_equals_evaluate_policies_for_every_citizen():
    expected = json.loads((ROOT / "data/expected.json").read_text(encoding="utf-8"))
    citizens = json.loads((ROOT / "data/citizens.json").read_text(encoding="utf-8"))["citizens"]
    as_of = date.fromisoformat(expected["evalDate"])
    for c in citizens:
        claims = evaluate_claims(BUNDLE, c, as_of)
        full = evaluate_policies(BUNDLE, claims)
        for pid in RULES:
            assert evaluate_policy_partial(BUNDLE, pid, claims) == {"eligible": full[pid], "pending": []}, \
                (c["citizenId"], pid)


@pytest.mark.parametrize("pid", sorted(RULES))
def test_partial_matches_reference_over_every_partial_assignment(pid):
    """규칙 변수마다 {모름, 거짓, 참} 의 모든 조합에서, 참조 구현(reference.py)으로 나머지를 전부 채워 본 결과와 같다.
    - eligible 이 bool 이면: 모르는 항목을 어떻게 채워도 참조 판정이 그 값이다.
    - eligible 이 None 이면: 참조 판정이 갈리고, pending 은 '하나만 뒤집어 결과가 바뀌는 경우가 있는' 항목 전부다."""
    names = sorted(rule_vars(RULES[pid]))
    for state in product([None, False, True], repeat=len(names)):
        known = {n: v for n, v in zip(names, state, strict=True) if v is not None}
        unknown = [n for n in names if n not in known]

        def ref(fill, unknown=unknown, known=known):
            return reference_policies({**ALL_FALSE, **known, **dict(zip(unknown, fill, strict=True))})[pid]

        fills = list(product([False, True], repeat=len(unknown)))
        outcomes = {ref(f) for f in fills}
        r = evaluate_policy_partial(BUNDLE, pid, known)
        if len(outcomes) == 1:
            assert r == {"eligible": outcomes.pop(), "pending": []}, (pid, known)
            continue
        assert r["eligible"] is None, (pid, known)
        flips = [n for i, n in enumerate(unknown)
                 if any(ref(f) != ref(f[:i] + (not f[i],) + f[i + 1:]) for f in fills)]
        assert r["pending"] == flips and flips, (pid, known, r)


def test_claim_sets_reads_legacy_required_claims():
    """지갑 캐시에 남은 2026.2 이전 정책 문서(requiredClaims 단일 목록)도 조합 하나로 읽는다."""
    legacy = [{"claim": "annualIncomeUnder35M", "expected": True}]
    assert claim_sets({"requiredClaims": legacy}) == [legacy]
    assert claim_sets({"requiredClaims": []}) == []
    assert claim_sets({}) == []
    # 새 형식이 있으면 그것이 우선
    new = [[{"claim": "annualIncomeUnder40M", "expected": True}]]
    assert claim_sets({"requiredClaimSets": new, "requiredClaims": legacy}) == new
