"""FastAPI 앱 `dbp_ai` — 대구 혜택패스 AI 서비스 (port AI_PORT, 기본 8004)."""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import chat, llm
from .config import allowed_origins
from .recommend import recommend
from .schemas import (
    CHAT_NOTICE,
    ChatCompleteResponse,
    ChatRequest,
    DeleteSessionResponse,
    HealthResponse,
    RecommendRequest,
    RecommendResponse,
)

log = logging.getLogger("dbp_ai")


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


def create_app() -> FastAPI:
    app = FastAPI(
        title="대구 혜택패스 AI 서비스",
        description="AI는 탐색·설명만 한다. 적격 판정은 규칙 엔진이 이미 끝냈고, 이 서비스는 그 결과를 쉬운 말로 설명한다.",
        version="0.1.0",
    )
    app.add_middleware(
        CORSMiddleware, allow_origins=allowed_origins(), allow_methods=["*"], allow_headers=["*"],
        expose_headers=["X-Audit-Id"],
    )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(ok=True, provider=llm.provider(), model=llm.model_name())

    @app.post("/recommend", response_model=RecommendResponse)
    def post_recommend(req: RecommendRequest) -> RecommendResponse:
        return recommend(req)

    @app.post("/chat")
    def post_chat(req: ChatRequest) -> StreamingResponse:
        audit_id = llm.new_audit_id()  # 헤더는 본문보다 먼저 나가므로 미리 정한다
        masked = chat.mask_pii(req.message)[1]

        def gen() -> Iterator[str]:
            provider = "template"
            for delta, provider in chat.stream(req, audit_id):
                yield _sse({"delta": delta})
            yield _sse({"done": True, "provider": provider, "sessionId": req.sessionId, "auditId": audit_id,
                        "eligibilitySource": "rule-engine", "notice": CHAT_NOTICE, "masked": masked})

        return StreamingResponse(
            gen(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Audit-Id": audit_id},
        )

    @app.post("/chat/complete", response_model=ChatCompleteResponse)
    def post_chat_complete(req: ChatRequest) -> ChatCompleteResponse:
        turn = chat.complete(req)
        return ChatCompleteResponse(sessionId=req.sessionId, text=turn.text, provider=turn.provider,
                                    masked=turn.masked, auditId=turn.auditId)

    @app.delete("/chat/{session_id}", response_model=DeleteSessionResponse)
    def delete_chat(session_id: str) -> DeleteSessionResponse:
        return DeleteSessionResponse(sessionId=session_id, discarded=chat.delete_session(session_id))

    @app.get("/audit/last-payload", status_code=410)
    def audit_last_payload() -> dict:
        """폐지: 프로세스 전체의 '마지막' 기록은 다른 사람의 질문을 보여 준다 (F12). auditId 로 조회한다."""
        raise HTTPException(status_code=410, detail="USE_AUDIT_ID")

    @app.get("/audit/{audit_id}")
    def audit_by_id(audit_id: str) -> dict:
        """시연 ② "AI가 받은 정보 보기": 그 응답을 만들 때 LLM 에 실제로 전달된 system·messages·model (템플릿이면 그 입력).
        auditId 는 /recommend·/chat/complete 응답과 /chat 의 X-Audit-Id 헤더로만 받는다. 10분 뒤 또는 세션 폐기 시 사라진다."""
        record = llm.get_audit(audit_id)
        if record is None:
            raise HTTPException(status_code=404, detail="AUDIT_UNKNOWN")
        return {"available": True, "auditId": audit_id, **record}

    return app


app = create_app()
