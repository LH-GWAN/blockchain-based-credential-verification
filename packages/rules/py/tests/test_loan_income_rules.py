"""서민금융 연소득 기준 경계값 (2026.2 번들).

- 햇살론 일반보증 (2026.1.2 근로자햇살론·햇살론뱅크 통합): 연소득 3,500만 원 이하, 또는 신용평점 하위 20% + 4,500만 원 이하
- 새희망홀씨Ⅱ (은행권): 연소득 4,000만 원 이하, 또는 신용평점 하위 20% + 5,000만 원 이하
기준은 모두 '이하'이므로 기준액은 참, 1원 초과는 거짓이어야 한다.
"""
from datetime import date

import pytest

from dbp_rules import evaluate_claims, evaluate_policies, load_bundle
from dbp_rules.reference import reference_policies

BUNDLE = load_bundle()
AS_OF = date(2026, 9, 14)
INCOME_CLAIMS = ["annualIncomeUnder35M", "annualIncomeUnder40M", "annualIncomeUnder45M", "annualIncomeUnder50M"]


def _bank_claims(tier: str, income: int) -> dict[str, bool]:
    """은행이 아는 두 값(신용 등급·연소득)만으로 claim 을 만든다."""
    return evaluate_claims(BUNDLE, {"creditScoreTier": tier, "annualIncomeKRW": income}, AS_OF,
                           only=["creditBottom20", *INCOME_CLAIMS])


def _loans(tier: str, income: int) -> dict[str, bool]:
    claims = {k: False for k in BUNDLE["claims"]["rules"]}
    claims.update(_bank_claims(tier, income))
    pol = evaluate_policies(BUNDLE, claims)
    # 엔진 판정 == 참조 구현 판정
    ref = reference_policies(claims)
    assert pol["sunshine-loan-general"] == ref["sunshine-loan-general"]
    assert pol["new-hope-loan"] == ref["new-hope-loan"]
    return {"sunshine": pol["sunshine-loan-general"], "newHope": pol["new-hope-loan"]}


@pytest.mark.parametrize("claim, limit", [
    ("annualIncomeUnder35M", 35_000_000), ("annualIncomeUnder40M", 40_000_000),
    ("annualIncomeUnder45M", 45_000_000), ("annualIncomeUnder50M", 50_000_000),
])
def test_income_claim_boundary(claim, limit):
    assert _bank_claims("other", limit)[claim] is True
    assert _bank_claims("other", limit + 1)[claim] is False


def test_new_income_claims_are_welfare_issued_and_labeled():
    assert BUNDLE["claims"]["issuerOf"]["annualIncomeUnder40M"] == "did:dbp:welfare"
    assert BUNDLE["claims"]["issuerOf"]["annualIncomeUnder50M"] == "did:dbp:welfare"
    assert BUNDLE["claims"]["labels"]["annualIncomeUnder40M"] == "연소득 4,000만 원 이하 여부"
    assert BUNDLE["claims"]["labels"]["annualIncomeUnder50M"] == "연소득 5,000만 원 이하 여부"


def test_new_hope_loan_branches():
    # 연소득 4,000만 원 이하면 신용평점과 무관하게 대상
    assert _loans("other", 40_000_000)["newHope"] is True
    assert _loans("other", 40_000_001)["newHope"] is False
    # 하위 20% 는 5,000만 원 이하까지
    assert _loans("bottom20", 50_000_000)["newHope"] is True
    assert _loans("bottom20", 50_000_001)["newHope"] is False
    # 하위 20% 가 아니면 4,500만 원이어도 대상 아님 (옛 3,500만/4,500만 기준과 다름)
    assert _loans("other", 45_000_000)["newHope"] is False


def test_sunshine_loan_general_keeps_35m_and_bottom20_45m():
    assert "sunshine-loan-bank" not in BUNDLE["policies"]["rules"]
    assert _loans("other", 35_000_000)["sunshine"] is True
    assert _loans("other", 35_000_001)["sunshine"] is False
    assert _loans("bottom20", 45_000_000)["sunshine"] is True
    assert _loans("bottom20", 45_000_001)["sunshine"] is False


def test_income_band_between_products():
    """3,500만 원 초과 ~ 4,000만 원 이하(신용 일반): 새희망홀씨만 대상, 햇살론 일반보증은 아니다."""
    assert _loans("other", 38_000_000) == {"sunshine": False, "newHope": True}
