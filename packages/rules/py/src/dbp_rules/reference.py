"""참조 구현 — JSON Logic 을 쓰지 않는 평범한 if/else. 기댓값(data/expected.json) 생성 전용.
엔진과 독립적으로 작성되어야 의미가 있으므로 engine.py 를 import 하지 않는다."""
from __future__ import annotations

from datetime import date


def age_on(birth: str, as_of: date) -> int:
    b = date.fromisoformat(birth)
    return as_of.year - b.year - (1 if (as_of.month, as_of.day) < (b.month, b.day) else 0)


def reference_claims(c: dict, median: dict, pension: dict, as_of: date) -> dict[str, bool]:
    hs = min(6, max(1, c["householdSize"]))
    m = int(median[str(hs)])
    inc = c["monthlyIncomeKRW"]
    age = age_on(c["birthDate"], as_of)
    line = pension["singleKRW"] if c["householdSize"] == 1 else pension["coupleKRW"]
    return {
        "daeguResident": c["residence"]["sido"] == "대구광역시",
        "ageOver65": age >= 65,
        "daeguMetroFreeAge": int(c["birthDate"][:4]) <= 1958,
        "singlePersonHousehold": c["householdSize"] == 1,
        "hasStudentChild": c["hasStudentChild"] is True,
        "isBenefitRecipient": c["isBasicLivelihoodRecipient"] is True,
        "incomeBelow32Median": inc * 100 <= m * 32,
        "incomeBelow48Median": inc * 100 <= m * 48,
        "incomeBelow50Median": inc * 100 <= m * 50,
        "incomeBelowBasicPensionLine": inc <= line,
        "creditBottom20": c["creditScoreTier"] == "bottom20",
        "annualIncomeUnder35M": c["annualIncomeKRW"] <= 35_000_000,
        "annualIncomeUnder40M": c["annualIncomeKRW"] <= 40_000_000,
        "annualIncomeUnder45M": c["annualIncomeKRW"] <= 45_000_000,
        "annualIncomeUnder50M": c["annualIncomeKRW"] <= 50_000_000,
    }


def reference_policies(k: dict[str, bool]) -> dict[str, bool]:
    return {
        "nbl-livelihood": k["incomeBelow32Median"],
        "nbl-housing": k["incomeBelow48Median"],
        "nbl-education": k["incomeBelow50Median"] and k["hasStudentChild"],
        "near-poor": k["incomeBelow50Median"] and not k["isBenefitRecipient"],
        "basic-pension": k["ageOver65"] and k["incomeBelowBasicPensionLine"],
        "energy-voucher": k["isBenefitRecipient"] and k["ageOver65"],
        "telecom-discount": k["isBenefitRecipient"] or k["incomeBelow50Median"],
        "micro-livelihood-loan": k["annualIncomeUnder35M"] and (k["creditBottom20"] or k["isBenefitRecipient"] or k["incomeBelow50Median"]),
        "daegu-metro-free": k["daeguResident"] and k["daeguMetroFreeAge"],
        "sunshine-loan-general": k["annualIncomeUnder35M"] or (k["creditBottom20"] and k["annualIncomeUnder45M"]),
        "new-hope-loan": k["annualIncomeUnder40M"] or (k["creditBottom20"] and k["annualIncomeUnder50M"]),
        "electricity-welfare-discount": k["isBenefitRecipient"] or k["incomeBelow50Median"] or (k["ageOver65"] and k["incomeBelowBasicPensionLine"]),
        "city-gas-discount": k["isBenefitRecipient"] or k["incomeBelow50Median"],
    }
