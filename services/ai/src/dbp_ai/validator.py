"""인용 검증기 (post-validator). 불변 조건 7: 근거 없으면 비노출.

LLM 추천 항목을 다음 기준으로 걸러낸다.
- policyId 가 적격 후보(규칙 엔진 eligible == true)가 아니면 제거
- citations 가 비었거나, 그 정책의 legalBasis 에 없는 clauseId 가 하나라도 있으면 제거
- headline/explanation/nextSteps 에 정책 DB 에 근거가 없는 제도명이 등장하면 제거
- 본문이 다른 등록 제도를 언급하는데 그 제도가 적격 후보가 아니면 제거 ("기초연금도 받으실 수 있습니다" 류, F23)
- 본문의 숫자(금액·나이·비율 등)가 그 정책 문서에 없는 값이면 제거 ("매달 50만원" 같은 금액 환각, F23)
- 같은 policyId 중복은 첫 항목만
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterable

from .retriever import PolicyStore
from .schemas import LLMRecommendation, Recommendation

# 영문·하이픈에 붙은 숫자(clauseId "nbl-housing-c2" 등)는 값이 아니므로 세지 않는다
_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9_\-])\d[\d,]*(?:\.\d+)?")


def number_tokens(text: str) -> set[str]:
    """본문의 숫자 토큰 (천 단위 쉼표 제거). "1,000,000" == "1000000"."""
    return {m.group(0).replace(",", "").rstrip(".") for m in _NUMBER_RE.finditer(text)}


def _policy_numbers(policy: dict) -> set[str]:
    return number_tokens(json.dumps(policy, ensure_ascii=False))


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
        text = f"{it.headline} {it.explanation} {it.nextSteps}"
        unknown = store.unknown_program_terms(text)
        if unknown:
            dropped.append({"policyId": pid, "reason": "unknown-program-name", "terms": unknown})
            continue
        others = [o for o in store.match_policies(text) if o != pid and o not in eligible_ids]
        if others:
            dropped.append({"policyId": pid, "reason": "mentions-ineligible-policy", "policyIds": others})
            continue
        stray = sorted(number_tokens(text) - _policy_numbers(store.by_id[pid]))
        if stray:
            dropped.append({"policyId": pid, "reason": "unknown-number", "numbers": stray})
            continue
        seen.add(pid)
        survivors.append(Recommendation(
            policyId=pid, headline=it.headline.strip(), explanation=it.explanation.strip(),
            citations=citations, nextSteps=it.nextSteps.strip(), source="llm",
        ))
    return survivors, dropped
