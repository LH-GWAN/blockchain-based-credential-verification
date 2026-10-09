"""데이터 계약 (Pydantic v2, 모두 extra="forbid").

`CategoricalProfile` 이 PII 방화벽이다: §7.3 allowlist 6개 필드 외에는 무엇이든 422 로 거부한다.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- 입력 ----


class CategoricalProfile(StrictModel):
    """규칙 엔진이 산출한 범주값만. 원본 필드(이름·생년월일·소득 금액 등)는 스키마 수준에서 차단된다."""

    ageBand: Literal["<65", "65+"]
    householdSize: int = Field(ge=1, le=6)
    residence: Literal["daegu", "other"]
    incomeBracket: Literal["≤32%", "≤48%", "≤50%", ">50%"]
    recipientStatus: Literal["none", "recipient", "near-poor"]
    creditTier: Literal["bottom20", "other"]


class RuleResult(StrictModel):
    policyId: str
    eligible: bool
    matchedClaims: list[str] = Field(default_factory=list)


class RecommendRequest(StrictModel):
    categoricalProfile: CategoricalProfile
    ruleResults: list[RuleResult]
    locale: Literal["ko"] = "ko"


class ChatRequest(StrictModel):
    sessionId: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4000)
    categoricalProfile: CategoricalProfile
    ruleResults: list[RuleResult]


# ---- LLM 구조화 출력 (Anthropic output_format) ----


class LLMRecommendation(StrictModel):
    policyId: str
    headline: str
    explanation: str
    citations: list[str]
    nextSteps: str


class RecommendationResponse(StrictModel):
    """LLM 이 반환해야 하는 구조. 검증기를 통과한 항목만 사용자에게 노출된다."""

    recommendations: list[LLMRecommendation]


# ---- 출력 ----

Provider = Literal["anthropic", "template"]

# 채팅 답변은 인용 검증기를 거치지 않는 설명이다. 판정 근거로 오해되지 않도록 응답마다 붙인다 (F22).
CHAT_NOTICE = "채팅 답변은 자격 판정이 아닙니다 — 판정은 규칙 엔진 결과만 따릅니다"


class Recommendation(StrictModel):
    policyId: str
    headline: str
    explanation: str
    citations: list[str]
    nextSteps: str
    source: Literal["llm", "template"]


class RecommendResponse(StrictModel):
    recommendations: list[Recommendation]
    disclaimer: str
    provider: Provider
    judgedBy: Literal["rule-engine"] = "rule-engine"  # 추천 후보는 규칙 엔진 적격 + 인용 검증기 통과 항목뿐이다
    eligibilitySource: Literal["rule-engine"] = "rule-engine"
    auditId: str  # GET /audit/{auditId} — 이 응답을 만들 때 AI(또는 템플릿)가 받은 입력


class ChatCompleteResponse(StrictModel):
    sessionId: str
    text: str
    provider: Provider
    eligibilitySource: Literal["rule-engine"] = "rule-engine"  # 적격 여부의 출처. 채팅 답변 자체는 판정이 아니다
    notice: str = CHAT_NOTICE
    masked: bool = False  # 질문에서 주민번호·전화번호·계좌·금액을 [가림] 으로 바꿨으면 true (F21)
    auditId: str


class HealthResponse(StrictModel):
    ok: bool = True
    provider: Provider
    model: str


class DeleteSessionResponse(StrictModel):
    sessionId: str
    discarded: bool
