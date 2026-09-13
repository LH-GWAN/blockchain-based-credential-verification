"""인용 검증기 (post-validator). 불변 조건 7: 근거 없으면 비노출.

LLM 추천 항목을 다음 기준으로 걸러낸다.
- policyId 가 적격 후보(규칙 엔진 eligible == true)가 아니면 제거
- citations 가 비었거나, 그 정책의 legalBasis 에 없는 clauseId 가 하나라도 있으면 제거
- headline/explanation/nextSteps 에 정책 DB 에 근거가 없는 제도명이 등장하면 제거
- 같은 policyId 중복은 첫 항목만
"""
from __future__ import annotations

from typing import Iterable

from .retriever import PolicyStore
from .schemas import LLMRecommendation, Recommendation


def validate_llm_recommendations(items: Iterable[LLMRecommendation], eligible_ids: set[str],
                                 store: PolicyStore) -> tuple[list[Recommendation], list[dict]]:
    survivors: list[Recommendation] = []
    dropped: list[dict] = []
    seen: set[str] = set()

    for it in items:
        pid = it.policyId
        if pid not in eligible_ids or pid not in store.by_id:
            dropped.append({"policyId": pid, "reason": "not-an-eligible-candidate"})
            continue
        if pid in seen:
            dropped.append({"policyId": pid, "reason": "duplicate"})
            continue
        citations = list(dict.fromkeys(c.strip() for c in it.citations if c and c.strip()))
        if not citations:
            dropped.append({"policyId": pid, "reason": "no-citation"})
            continue
        valid = store.clause_ids(pid)
        bad = [c for c in citations if c not in valid]
        if bad:
            dropped.append({"policyId": pid, "reason": "unknown-clause", "clauseIds": bad})
            continue
        if not it.headline.strip() or not it.explanation.strip():
            dropped.append({"policyId": pid, "reason": "empty-text"})
            continue
        unknown = store.unknown_program_terms(" ".join([it.headline, it.explanation, it.nextSteps]))
        if unknown:
            dropped.append({"policyId": pid, "reason": "unknown-program-name", "terms": unknown})
            continue
        seen.add(pid)
        survivors.append(Recommendation(
            policyId=pid, headline=it.headline.strip(), explanation=it.explanation.strip(),
            citations=citations, nextSteps=it.nextSteps.strip(), source="llm",
        ))
    return survivors, dropped
