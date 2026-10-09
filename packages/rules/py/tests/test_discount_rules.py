"""공공요금 감면 규칙 (2026.2, F05 회귀).

- 전기요금 복지할인(한전): 수급자 OR 기준 중위소득 50% 이하. 기초연금 수급자는 한전 복지할인 대상 구분에 없다
  (장애인·국가유공자·수급자·차상위·대가족·다자녀·출산가구 등).
- 이동통신 요금감면: 수급자 OR 50% 이하 OR 기초연금 수급자(만 65세 이상 AND 기초연금 선정기준액 이하).
  기초연금 수급자는 이용료 50%, 월 최대 11,000원 감면 (복지로 안내).
"""
import json

from dbp_rules import evaluate_policies, evaluate_policy_partial, load_bundle, repo_root
from dbp_rules.reference import reference_policies

BUNDLE = load_bundle()
ALL_FALSE = {k: False for k in BUNDLE["claims"]["rules"]}
PENSION_ONLY = {**ALL_FALSE, "ageOver65": True, "incomeBelowBasicPensionLine": True}
EXPECTED = {r["citizenId"]: r for r in
            json.loads((repo_root() / "data/expected.json").read_text(encoding="utf-8"))["rows"]}


def test_basic_pension_line_alone_gives_telecom_but_not_electricity():
    pol = evaluate_policies(BUNDLE, PENSION_ONLY)
    assert pol == reference_policies(PENSION_ONLY)
    assert pol["basic-pension"] is True
    assert pol["telecom-discount"] is True
    assert pol["electricity-welfare-discount"] is False
    assert pol["city-gas-discount"] is False


def test_basic_pension_path_needs_both_age_and_line_for_telecom():
    assert evaluate_policies(BUNDLE, {**PENSION_ONLY, "ageOver65": False})["telecom-discount"] is False
    assert evaluate_policies(BUNDLE, {**PENSION_ONLY, "incomeBelowBasicPensionLine": False})["telecom-discount"] is False


def test_recipient_or_half_median_still_gives_all_three_discounts():
    for k in ["isBenefitRecipient", "incomeBelow50Median"]:
        pol = evaluate_policies(BUNDLE, {**ALL_FALSE, k: True})
        assert pol["telecom-discount"] and pol["electricity-welfare-discount"] and pol["city-gas-discount"], k


def test_partial_judgement_on_pension_claims():
    known = {"ageOver65": True, "incomeBelowBasicPensionLine": True}
    assert evaluate_policy_partial(BUNDLE, "telecom-discount", known) == {"eligible": True, "pending": []}
    # 전기요금은 기초연금 항목과 무관 — 수급 여부·50% 이하를 모르면 보류
    r = evaluate_policy_partial(BUNDLE, "electricity-welfare-discount", known)
    assert r == {"eligible": None, "pending": ["incomeBelow50Median", "isBenefitRecipient"]}


def test_c013_basic_pension_single_verdicts():
    """C-013: 만 65세 이상 단독가구, 월 150만 원 (기초연금 선정기준 이하, 중위 50% 초과, 수급자 아님)."""
    row = EXPECTED["C-013"]
    c = row["claims"]
    assert c["ageOver65"] and c["incomeBelowBasicPensionLine"]
    assert not c["incomeBelow50Median"] and not c["isBenefitRecipient"]
    p = row["policies"]
    assert p["basic-pension"] is True
    assert p["telecom-discount"] is True
    assert p["electricity-welfare-discount"] is False
    assert p["city-gas-discount"] is False


def test_other_pension_only_citizens_follow_the_same_split():
    for cid in ["C-015", "C-017"]:
        p = EXPECTED[cid]["policies"]
        assert p["basic-pension"] and p["telecom-discount"], cid
        assert not p["electricity-welfare-discount"] and not p["city-gas-discount"], cid
