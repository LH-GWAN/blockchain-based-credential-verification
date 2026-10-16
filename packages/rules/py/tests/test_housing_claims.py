"""주거 대출(버팀목·디딤돌)·대구 청년 이자지원 창구가 받는 사실 (2026.2 번들).

등본(세대주)·혼인관계증명서(혼인)·건보 자격득실확인서(재직)·소득금액증명(연소득 6,000만) 원본을 대신하는 참·거짓.
"""
from datetime import date

import pytest
from dbp_rules import evaluate_claims, load_bundle
from dbp_rules.reference import reference_claims

BUNDLE = load_bundle()
AS_OF = date(2026, 9, 14)
NEW = ["householdHead", "married", "employed", "annualIncomeUnder60M"]


def test_issuers_and_labels():
    io, lb = BUNDLE["claims"]["issuerOf"], BUNDLE["claims"]["labels"]
    assert io["householdHead"] == io["married"] == "did:dbp:daegu"  # 주민등록·가족관계
    assert io["employed"] == io["annualIncomeUnder60M"] == "did:dbp:welfare"  # 건보 자격·소득
    assert lb["householdHead"] == "세대주 여부"
    assert lb["employed"] == "재직 중 여부 (직장 건강보험 가입)"
    assert lb["annualIncomeUnder60M"] == "연소득 6,000만 원 이하 여부"


@pytest.mark.parametrize("income, expected", [(60_000_000, True), (60_000_001, False)])
def test_income_60m_boundary(income, expected):
    assert evaluate_claims(BUNDLE, {"annualIncomeKRW": income}, AS_OF, only=["annualIncomeUnder60M"]) == {
        "annualIncomeUnder60M": expected}


@pytest.mark.parametrize("field, claim", [("isHouseholdHead", "householdHead"), ("isMarried", "married"),
                                          ("isEmployed", "employed")])
def test_boolean_claims_follow_record(field, claim):
    assert evaluate_claims(BUNDLE, {field: True}, AS_OF, only=[claim]) == {claim: True}
    assert evaluate_claims(BUNDLE, {field: False}, AS_OF, only=[claim]) == {claim: False}


def test_engine_matches_reference_on_seed_citizens():
    import json

    from dbp_rules import repo_root
    root = repo_root()
    median = json.loads((root / "data/median-income-2026.json").read_text())
    pension = median["basicPension2026"]
    for c in json.loads((root / "data/citizens.json").read_text())["citizens"]:
        eng = evaluate_claims(BUNDLE, c, AS_OF, only=NEW)
        ref = reference_claims(c, median["byHouseholdSize"], pension, AS_OF)
        assert eng == {k: ref[k] for k in NEW}, c["citizenId"]
