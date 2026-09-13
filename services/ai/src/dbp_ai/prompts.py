"""시스템 프롬프트와 사용자 메시지 빌더.

시스템 프롬프트(규칙 + 정책 문서 전체)는 고정 프리픽스로 두고 `cache_control` 을 건다.
범주 프로필·판정 결과처럼 요청마다 바뀌는 값은 프리픽스 뒤(두 번째 system 블록 또는 user 메시지)에 둔다.
"""
from __future__ import annotations

from collections.abc import Iterable
from functools import lru_cache

from .retriever import InContextRetriever, PolicyStore, get_store
from .schemas import CategoricalProfile, RuleResult

SYSTEM_RULES = """당신은 '대구 혜택패스'의 혜택 안내 도우미입니다. 대구 시민, 특히 어르신께 복지·금융·교통 혜택을 쉽게 설명하는 일을 합니다.

[절대 규칙]
1. 당신은 자격을 판정하지 않는다. 적격 여부는 규칙 엔진이 이미 결정했고, 당신은 그 결과만 설명한다. 판정을 뒤집거나 새로 추측하지 않는다.
2. 규칙 엔진이 적격으로 판정한 제도만 추천한다. 부적격으로 판정된 제도는 추천하지 않으며, 물어보면 "규칙 엔진 판정 결과 현재 기준에는 해당하지 않습니다"라고 결과만 전한다.
3. 정책 DB에 없는 제도는 "등록되어 있지 않습니다"라고 답한다. 정책 DB에 없는 제도·조항·금액을 만들어 내지 않는다. 그런 제도에 대해서는 자격 판정도, 추측도 하지 않는다.
4. 원본 개인정보(이름·생년월일·소득 금액·주민번호·주소·계좌번호)를 요구하거나 추정하지 않는다. 당신에게는 규칙 엔진이 만든 범주값만 주어진다. 사용자가 원본 개인정보를 말하려 하면 "말씀하지 않으셔도 됩니다"라고 안내한다.
5. 근거를 댈 때는 반드시 아래 정책 문서에 있는 clauseId를 그대로 인용한다. 문서에 없는 조항 번호나 법령을 쓰지 않는다.
6. 쉬운 한국어, 존댓말, 짧은 문장을 쓴다. 고령자 기준으로 한 문장에 한 가지 내용만 담고, 어려운 행정 용어는 풀어서 쓴다.
7. "적격"·"신청 가능"이라고 말할 때는 그것이 규칙 엔진의 판정 결과임을 밝힌다. 최종 수급 여부는 담당 기관 심사로 정해진다고 덧붙인다.
"""


def _render_policy(doc: dict) -> str:
    lines = [
        f"### policyId: {doc['policyId']} | 제도명: {doc['name']} | 분류: {doc['category']} | 담당: {doc['agency']}",
        f"- 요약: {doc['summary']}",
        f"- 신청 방법: {doc['howToApply']}",
        "- 근거 조항:",
    ]
    for c in doc["legalBasis"]:
        lines.append(f"  - clauseId: {c['clauseId']} | {c['title']} | {c['text']}")
    if doc.get("notes"):
        lines.append(f"- 비고: {doc['notes']}")
    if doc.get("basisVerified") is False:
        lines.append("- 주의: 기준값 출처 미확인 (예시 기준)")
    return "\n".join(lines)


def build_system_prompt(store: PolicyStore, retriever: InContextRetriever | None = None) -> str:
    retriever = retriever or InContextRetriever(store)
    docs = retriever.retrieve()
    names = ", ".join(d["name"] for d in docs)
    body = "\n\n".join(_render_policy(d) for d in docs)
    return (
        SYSTEM_RULES
        + "\n[정책 DB — 등록된 제도 전체]\n"
        + f"등록된 제도명 목록: {names}\n"
        + "이 목록에 없는 제도를 물으면 \"등록되어 있지 않습니다\"라고 답한다.\n\n"
        + body
        + "\n"
    )


@lru_cache(maxsize=1)
def system_prompt_text() -> str:
    return build_system_prompt(get_store())


def cached_system_blocks() -> list[dict]:
    """고정 프리픽스 (규칙 + 정책 문서). 마지막에 cache_control 을 건다."""
    return [{"type": "text", "text": system_prompt_text(), "cache_control": {"type": "ephemeral"}}]


# ---- 범주 프로필 / 판정 결과 렌더링 ----

_AGE = {"<65": "65세 미만", "65+": "65세 이상"}
_RES = {"daegu": "대구 거주", "other": "대구 외 거주"}
_INC = {"≤32%": "기준 중위소득 32% 이하", "≤48%": "기준 중위소득 48% 이하", "≤50%": "기준 중위소득 50% 이하", ">50%": "기준 중위소득 50% 초과"}
_REC = {"none": "수급자 아님", "recipient": "기초생활보장 수급자", "near-poor": "차상위(수급자 아님, 50% 이하)"}
_CRD = {"bottom20": "신용평점 하위 20%", "other": "신용평점 하위 20% 아님"}


def render_profile(p: CategoricalProfile) -> str:
    return (
        f"ageBand={p.ageBand} ({_AGE[p.ageBand]}), householdSize={p.householdSize} (가구원 {p.householdSize}명), "
        f"residence={p.residence} ({_RES[p.residence]}), incomeBracket={p.incomeBracket} ({_INC[p.incomeBracket]}), "
        f"recipientStatus={p.recipientStatus} ({_REC[p.recipientStatus]}), creditTier={p.creditTier} ({_CRD[p.creditTier]})"
    )


def _render_rule_line(r: RuleResult, store: PolicyStore) -> str:
    p = store.get(r.policyId)
    name = p["name"] if p else "(미등록)"
    claims = ", ".join(r.matchedClaims) if r.matchedClaims else "-"
    return f"  - {r.policyId} ({name}) | 충족 claim: {claims}"


def render_rule_results(eligible: Iterable[RuleResult], ineligible: Iterable[RuleResult], store: PolicyStore) -> str:
    el = list(eligible)
    inel = list(ineligible)
    lines = ["- 적격 판정 (추천 후보 — 이 목록 밖의 제도는 추천 금지):"]
    lines += [_render_rule_line(r, store) for r in el] or ["  - (없음)"]
    lines.append("- 부적격 판정 (추천 금지. 질문을 받으면 '규칙 엔진 판정 결과 현재 기준에는 해당하지 않습니다'라고만 설명):")
    lines += [_render_rule_line(r, store) for r in inel] or ["  - (없음)"]
    return "\n".join(lines)


def build_recommend_user_message(profile: CategoricalProfile, eligible: list[RuleResult],
                                 ineligible: list[RuleResult], store: PolicyStore, max_items: int = 3) -> str:
    return (
        "[규칙 엔진 판정 결과]\n"
        f"- 범주 프로필: {render_profile(profile)}\n"
        f"{render_rule_results(eligible, ineligible, store)}\n\n"
        "[요청]\n"
        f"적격 판정 목록 안에서 이 분께 가장 도움이 될 제도를 최대 {max_items}개 고르십시오.\n"
        "각 항목에 policyId, headline(한 줄), explanation(쉬운 말·존댓말·짧은 문장 3~4개), "
        "citations(정책 문서의 clauseId 만, 1개 이상), nextSteps(신청 방법)를 채우십시오.\n"
        "적격 목록에 없는 policyId, 문서에 없는 clauseId, 등록되지 않은 제도명을 쓰면 그 항목은 폐기됩니다.\n"
        "자격을 새로 판정하지 말고, 규칙 엔진 결과를 설명만 하십시오."
    )


def build_chat_context_block(profile: CategoricalProfile, rule_results: list[RuleResult], store: PolicyStore) -> dict:
    """채팅용 두 번째 system 블록 (가변 — 캐시 프리픽스 뒤)."""
    eligible = [r for r in rule_results if r.eligible]
    ineligible = [r for r in rule_results if not r.eligible]
    text = (
        "[이번 상담의 규칙 엔진 판정 결과 — 이 정보와 정책 DB 만 사용한다]\n"
        f"- 범주 프로필: {render_profile(profile)}\n"
        f"{render_rule_results(eligible, ineligible, store)}\n"
        "위 목록과 정책 DB 에 없는 제도를 물으면 \"등록되어 있지 않습니다\"라고 답하고 자격 판정을 하지 않는다."
    )
    return {"type": "text", "text": text}
