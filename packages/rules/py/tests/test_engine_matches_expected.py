"""합성 시민 30명 × 정책 13개: 엔진 출력 == 참조 구현 기댓값 (100% 일치 필수)."""
import json
from datetime import date

from dbp_rules import bundle_hash, categorical_profile, evaluate_claims, evaluate_policies, load_bundle, repo_root

ROOT = repo_root()
EXPECTED = json.loads((ROOT / "data/expected.json").read_text(encoding="utf-8"))
CITIZENS = {c["citizenId"]: c for c in json.loads((ROOT / "data/citizens.json").read_text(encoding="utf-8"))["citizens"]}
BUNDLE = load_bundle()


def test_bundle_hash_matches_expected_file():
    assert bundle_hash(BUNDLE) == EXPECTED["bundleHash"]


def test_all_rows_match():
    as_of = date.fromisoformat(EXPECTED["evalDate"])
    mismatches = []
    for row in EXPECTED["rows"]:
        c = CITIZENS[row["citizenId"]]
        claims = evaluate_claims(BUNDLE, c, as_of)
        policies = evaluate_policies(BUNDLE, claims)
        if claims != row["claims"]:
            mismatches.append((row["citizenId"], "claims", claims, row["claims"]))
        if policies != row["policies"]:
            mismatches.append((row["citizenId"], "policies", policies, row["policies"]))
    assert not mismatches, mismatches
    assert len(EXPECTED["rows"]) == 30
    assert EXPECTED["verdictCount"] >= 150


def test_persona_outcome():
    c = CITIZENS["C-001"]
    claims = evaluate_claims(BUNDLE, c, date(2026, 9, 14))
    pol = evaluate_policies(BUNDLE, claims)
    assert claims["daeguResident"] and claims["incomeBelow50Median"] and claims["ageOver65"]
    assert not claims["incomeBelow32Median"]
    assert pol["nbl-housing"] and pol["basic-pension"] and pol["daegu-metro-free"] and pol["micro-livelihood-loan"]
    assert not pol["nbl-livelihood"] and not pol["nbl-education"] and not pol["energy-voucher"]
    cat = categorical_profile(claims, c["householdSize"])
    assert cat == {"ageBand": "65+", "householdSize": 1, "residence": "daegu", "incomeBracket": "≤48%",
                   "recipientStatus": "near-poor", "creditTier": "bottom20"}
    # 범주값에는 원본 수치가 없다
    assert "monthlyIncomeKRW" not in json.dumps(cat) and "1000000" not in json.dumps(cat)


def test_policies_evaluate_from_claims_only():
    """검증기관은 원본 프로필 없이 claim 만으로 정책 판정을 재현할 수 있어야 한다."""
    claims = {k: False for k in BUNDLE["claims"]["rules"]}
    claims.update({"daeguResident": True, "incomeBelow50Median": True})
    pol = evaluate_policies(BUNDLE, claims)
    assert pol["telecom-discount"] is True and pol["near-poor"] is True and pol["nbl-housing"] is False


def test_partial_profile_only_evaluates_requested_claims():
    """은행(iM뱅크)은 신용·연소득만 안다. 자기 소관 claim 만 평가하면 다른 입력이 없어도 동작해야 한다."""
    import pytest
    bank_record = {"creditScoreTier": "bottom20", "annualIncomeKRW": 12_000_000}
    out = evaluate_claims(BUNDLE, bank_record, date(2026, 9, 14), only=["creditBottom20", "annualIncomeUnder35M"])
    assert out == {"creditBottom20": True, "annualIncomeUnder35M": True}
    with pytest.raises(TypeError):
        evaluate_claims(BUNDLE, bank_record, date(2026, 9, 14), only=["incomeBelow50Median"])


def test_empty_only_evaluates_nothing():
    """F63: only=[] 은 '평가할 항목 없음' — 전체 claim 평가로 바뀌지 않는다 (None 일 때만 전체)."""
    c = CITIZENS["C-001"]
    assert evaluate_claims(BUNDLE, c, date(2026, 9, 14), only=[]) == {}
    assert set(evaluate_claims(BUNDLE, c, date(2026, 9, 14))) == set(BUNDLE["claims"]["rules"])
