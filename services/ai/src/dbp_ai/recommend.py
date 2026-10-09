"""/recommend — 후보 결정권은 규칙 엔진에 있다.

1. ruleResults 에서 eligible == true 인 정책만 후보로 삼는다 (부적격은 "추천 금지" 로만 LLM 에 보인다).
2. provider 가 anthropic 이면 구조화 출력(`RecommendationResponse`)으로 LLM 을 부른다. 실패·거부 시 템플릿.
3. 인용 검증기를 통과한 항목만 남기고, 3개 미만이면 남은 적격 정책을 템플릿 설명으로 채운다.
"""
from __future__ import annotations

import logging

from . import llm
from .prompts import build_recommend_user_message, cached_system_blocks
from .retriever import PolicyStore, get_store
from .schemas import CategoricalProfile, RecommendRequest, RecommendResponse, RuleResult
from .template import template_recommendations
from .validator import validate_llm_recommendations

log = logging.getLogger("dbp_ai.recommend")

MAX_ITEMS = 3
DISCLAIMER = (
    "이 추천은 규칙 엔진이 적격으로 판정한 제도만 설명한 것입니다. AI는 자격을 판정하지 않습니다. "
    "최종 수급 여부는 담당 기관 심사로 정해집니다. "
    "이름·생년월일·소득 금액 같은 원본 개인정보는 AI에 전달되지 않았습니다."
)


def build_recommend_payload(profile: CategoricalProfile, eligible: list[RuleResult], ineligible: list[RuleResult],
                            store: PolicyStore, model: str) -> dict:
    """SDK 에 그대로 넘어가는 페이로드. 고정 프리픽스(system, cache_control) 뒤에 가변 값(user 메시지)."""
    return {
        "model": model,
        "max_tokens": 4096,
        "system": cached_system_blocks(),
        "messages": [{"role": "user", "content": build_recommend_user_message(profile, eligible, ineligible, store, MAX_ITEMS)}],
        "output_format": "RecommendationResponse",
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "medium"},
    }


def recommend(req: RecommendRequest) -> RecommendResponse:
    store = get_store()
    known = [r for r in req.ruleResults if r.policyId in store.by_id]
    eligible = [r for r in known if r.eligible]
    ineligible = [r for r in known if not r.eligible]
    eligible_ids = {r.policyId for r in eligible}

    audit_id = llm.new_audit_id()
    used_provider = "template"
    llm_items = []
    if eligible and llm.provider() == "anthropic":
        payload = build_recommend_payload(req.categoricalProfile, eligible, ineligible, store, llm.model_name())
        try:
            parsed = llm.llm_call("recommend", payload, audit_id=audit_id)
            llm_items = list(parsed.recommendations)
            used_provider = "anthropic"
        except Exception as e:  # noqa: BLE001 — 시연은 절대 멈추지 않는다
            log.warning("recommend: llm failed, falling back to template error=%s", llm.describe_error(e))

    if used_provider == "template":
        llm.record_template_inputs("recommend", {
            "categoricalProfile": req.categoricalProfile.model_dump(),
            "ruleResults": [r.model_dump() for r in known],
            "candidatePolicyIds": sorted(eligible_ids),
        }, audit_id=audit_id)

    survivors, dropped = validate_llm_recommendations(llm_items, eligible_ids, store)
    if dropped:
        log.info("recommend: dropped %d llm item(s) reasons=%s", len(dropped), [d["reason"] for d in dropped])

    items = survivors[:MAX_ITEMS]
    if len(items) < MAX_ITEMS:
        items += template_recommendations(eligible_ids, store, limit=MAX_ITEMS - len(items),
                                          exclude={i.policyId for i in items})
    return RecommendResponse(recommendations=items, disclaimer=DISCLAIMER, provider=used_provider, auditId=audit_id)
