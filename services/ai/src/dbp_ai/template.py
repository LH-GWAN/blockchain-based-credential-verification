"""템플릿 provider — LLM 없이도 시연이 멈추지 않도록 규칙 항목을 결정론적으로 문장화한다.

- 추천: summary + howToApply + legalBasis[0] 로 설명을 만들고 legalBasis[0].clauseId 를 인용한다.
- 정렬: 복지 → 금융 → 교통 → (그 외 분류) → policyId.
- 상담: 등록된 제도를 물으면 규칙 엔진 결과만 전하고, 미등록 제도는 "등록되어 있지 않습니다" 라고만 답한다 (판정 없음).
"""
from __future__ import annotations

import re
from typing import Iterable, Iterator

from .retriever import PolicyStore, PROGRAM_SUFFIXES
from .schemas import CategoricalProfile, Recommendation, RuleResult

CATEGORY_RANK = {"복지": 0, "금융": 1, "교통": 2}

NOT_REGISTERED = "등록되어 있지 않습니다"


def order_key(policy: dict) -> tuple[int, str]:
    return (CATEGORY_RANK.get(policy.get("category", ""), 3), policy["policyId"])


def sort_policies(policies: Iterable[dict]) -> list[dict]:
    return sorted(policies, key=order_key)


def template_item(policy: dict) -> Recommendation:
    clause = policy["legalBasis"][0]
    name = policy["name"]
    explanation = (
        f"{policy['summary']} "
        "규칙 엔진이 확인한 결과, 이 제도의 신청 기준을 충족합니다. "
        f"근거는 {clause['title']}입니다. {clause['text']}"
    )
    next_steps = f"{policy['howToApply']}. 최종 수급 여부는 담당 기관 심사로 정해집니다."
    return Recommendation(
        policyId=policy["policyId"],
        headline=f"{name} — 신청하실 수 있습니다",
        explanation=explanation,
        citations=[clause["clauseId"]],
        nextSteps=next_steps,
        source="template",
    )


def template_recommendations(eligible_ids: Iterable[str], store: PolicyStore, limit: int = 3,
                             exclude: Iterable[str] = ()) -> list[Recommendation]:
    ex = set(exclude)
    policies = [store.by_id[pid] for pid in eligible_ids if pid in store.by_id and pid not in ex]
    return [template_item(p) for p in sort_policies(policies)[:limit]]


# ---- 상담 ----

_PROGRAM_QUESTION_RE = re.compile("|".join(PROGRAM_SUFFIXES) + r"|혜택|제도|지원|신청|카드|받을")
# "청년 지원금" 처럼 띄어 쓴 제도명도 잡는다 (상담 전용 — 검증기는 정밀도를 위해 붙여 쓴 어절만 본다)
_SPACED_PROGRAM_RE = re.compile(r"([가-힣]{2,})\s+(" + "|".join(PROGRAM_SUFFIXES) + ")")
_FOOTER = "이 안내는 규칙 엔진의 판정 결과를 설명한 것입니다. 최종 수급 여부는 담당 기관 심사로 정해집니다."


def mentions_unknown_program(message: str, store: PolicyStore) -> bool:
    if store.unknown_program_terms(message):
        return True
    return any(not store.is_known_term(m.group(1) + m.group(2)) for m in _SPACED_PROGRAM_RE.finditer(message))


def _policy_answer(policy: dict, rule: RuleResult | None) -> str:
    clause = policy["legalBasis"][0]
    if rule is None:
        verdict = "이 제도에 대한 규칙 엔진 판정 결과는 아직 없습니다."
    elif rule.eligible:
        verdict = "규칙 엔진 판정 결과, 신청 기준을 충족합니다."
    else:
        verdict = "규칙 엔진 판정 결과, 현재 기준에는 해당하지 않습니다."
    return (
        f"{policy['name']}: {policy['summary']} {verdict} "
        f"신청 방법: {policy['howToApply']}. (근거: {clause['title']}, {clause['clauseId']})"
    )


def template_chat_answer(message: str, profile: CategoricalProfile, rule_results: list[RuleResult],
                         store: PolicyStore) -> str:
    by_id = {r.policyId: r for r in rule_results}
    matched = store.match_policies(message)
    if matched:
        lines = [_policy_answer(store.by_id[pid], by_id.get(pid)) for pid in matched]
        return "\n".join(lines) + "\n" + _FOOTER

    if _PROGRAM_QUESTION_RE.search(message) and mentions_unknown_program(message, store):
        names = ", ".join(store.names)
        return (
            f"말씀하신 제도는 정책 DB에 {NOT_REGISTERED}. 저는 등록된 제도만 안내해 드립니다. "
            f"등록된 제도: {names}. 이 중에서 궁금한 제도의 이름을 말씀해 주세요."
        )

    eligible = [store.by_id[pid] for pid in by_id if by_id[pid].eligible and pid in store.by_id]
    if eligible:
        names = ", ".join(p["name"] for p in sort_policies(eligible))
        return (
            f"규칙 엔진 판정 결과, 신청 기준을 충족하는 제도는 {names}입니다. "
            "궁금한 제도의 이름을 말씀해 주시면 신청 방법을 알려 드립니다. " + _FOOTER
        )
    return (
        "규칙 엔진 판정 결과, 현재 신청 기준을 충족하는 제도가 없습니다. "
        f"등록된 제도: {', '.join(store.names)}. 궁금한 제도의 이름을 말씀해 주세요. " + _FOOTER
    )


def chunk_text(text: str, size: int = 24) -> Iterator[str]:
    """템플릿 답변을 SSE 로 흘려보내기 위한 조각 내기 (시연용 타이핑 효과)."""
    for i in range(0, len(text), size):
        yield text[i:i + size]
