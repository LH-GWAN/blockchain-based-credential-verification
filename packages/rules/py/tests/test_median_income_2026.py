"""2026년 기준 중위소득·기초연금 선정기준액 고정값.

- 기준 중위소득: 보건복지부 고시 제2025-135호 (월, 원). 2026.2 이전 데이터는 5인·6인 값이 틀렸다(F04).
- 기초연금 선정기준액: 단독 247만 원, 부부 395만 2천 원 (2026 보건복지부 보도자료).
- 7인 이상 가구는 MVP 에서 6인 기준을 그대로 쓴다 (전처리 clampInt max=6).
값이 바뀌면 번들 해시가 바뀌므로, 고시 개정 없이 숫자가 움직이면 이 테스트가 먼저 잡는다.
"""
import json
from datetime import date

import pytest
from dbp_rules import evaluate_claims, load_bundle, repo_root

MEDIAN = json.loads((repo_root() / "data/median-income-2026.json").read_text(encoding="utf-8"))
BUNDLE = load_bundle()
AS_OF = date(2026, 9, 14)

GOSI_2025_135 = {"1": 2_564_238, "2": 4_199_292, "3": 5_359_036, "4": 6_494_738, "5": 7_556_719, "6": 8_555_952}


def test_median_income_matches_gosi_2025_135():
    assert MEDIAN["year"] == 2026
    assert "제2025-135호" in MEDIAN["source"]
    assert MEDIAN["verified"] is True and MEDIAN["verifiedOn"] == "2026-10-09"
    assert MEDIAN["byHouseholdSize"] == GOSI_2025_135
    assert MEDIAN["benefitLinePercent"] == {"livelihood": 32, "medical": 40, "housing": 48, "education": 50}


def test_basic_pension_line_2026():
    assert MEDIAN["basicPension2026"]["singleKRW"] == 2_470_000
    assert MEDIAN["basicPension2026"]["coupleKRW"] == 3_952_000


def test_bundle_tables_are_derived_from_the_file():
    t = BUNDLE["tables"]
    assert t["medianIncomeByHouseholdSize"] == GOSI_2025_135
    assert t["basicPensionLineByHouseholdKind"] == {"single": 2_470_000, "couple": 3_952_000}
    assert t["medianIncomeYear"] == 2026


def _profile(size: int, monthly: int) -> dict:
    return {"birthDate": "1980-01-15", "residence": {"sido": "대구광역시", "sigungu": "중구"}, "householdSize": size,
            "monthlyIncomeKRW": monthly, "isBasicLivelihoodRecipient": False, "hasStudentChild": False,
            "creditScoreTier": "other", "annualIncomeKRW": monthly * 12}


@pytest.mark.parametrize("size", [1, 2, 3, 4, 5, 6])
@pytest.mark.parametrize("claim, pct", [("incomeBelow32Median", 32), ("incomeBelow48Median", 48),
                                        ("incomeBelow50Median", 50)])
def test_median_line_boundary_per_household_size(size, claim, pct):
    """'이하' 기준: 가구원수별 선의 내림 금액은 참, 1원 많으면 거짓 (정수 연산, 반올림 없음)."""
    line = GOSI_2025_135[str(size)] * pct // 100
    only = [claim]
    assert evaluate_claims(BUNDLE, _profile(size, line), AS_OF, only=only)[claim] is True
    assert evaluate_claims(BUNDLE, _profile(size, line + 1), AS_OF, only=only)[claim] is False


@pytest.mark.parametrize("size", [7, 8, 10])
def test_households_of_seven_or_more_use_the_six_person_value(size):
    """MVP 단순화: 7인 이상은 6인 기준 중위소득으로 판정한다 (고시의 7인 이상 산식은 아직 반영하지 않음)."""
    line50 = GOSI_2025_135["6"] // 2
    for monthly in [line50, line50 + 1, GOSI_2025_135["6"] * 32 // 100]:
        assert evaluate_claims(BUNDLE, _profile(size, monthly), AS_OF) == \
            evaluate_claims(BUNDLE, _profile(6, monthly), AS_OF), (size, monthly)


def test_large_household_citizens_follow_the_corrected_table():
    """5·6인 값 정정(F04)으로 움직인 합성 시민: C-011·C-012 는 48% 선 정확히, C-030 은 32% 선 위."""
    citizens = {c["citizenId"]: c for c in
                json.loads((repo_root() / "data/citizens.json").read_text(encoding="utf-8"))["citizens"]}
    for cid, size in [("C-011", 5), ("C-012", 6)]:
        c = citizens[cid]
        assert c["householdSize"] == size and c["monthlyIncomeKRW"] == GOSI_2025_135[str(size)] * 48 // 100, cid
        claims = evaluate_claims(BUNDLE, c, AS_OF)
        assert claims["incomeBelow48Median"] and not claims["incomeBelow32Median"], cid
        bumped = evaluate_claims(BUNDLE, {**c, "monthlyIncomeKRW": c["monthlyIncomeKRW"] + 1}, AS_OF)
        assert bumped["incomeBelow48Median"] is False, cid
    c030 = citizens["C-030"]
    assert c030["householdSize"] == 6 and c030["monthlyIncomeKRW"] > GOSI_2025_135["6"] * 32 // 100
    assert evaluate_claims(BUNDLE, c030, AS_OF)["incomeBelow32Median"] is False
