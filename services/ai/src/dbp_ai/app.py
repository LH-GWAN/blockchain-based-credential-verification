"""FastAPI 앱 `dbp_ai` — 대구 혜택패스 AI 서비스 (port AI_PORT, 기본 8004)."""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import chat, llm
from .recommend import recommend
from .schemas import (
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
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(ok=True, provider=llm.provider(), model=llm.model_name())

    @app.post("/recommend", response_model=RecommendResponse)
    def post_recommend(req: RecommendRequest) -> RecommendResponse:
        return recommend(req)

    @app.post("/chat")
    def post_chat(req: ChatRequest) -> StreamingResponse:
        def gen() -> Iterator[str]:
            provider = "template"
            for delta, provider in chat.stream(req):
                yield _sse({"delta": delta})
            yield _sse({"done": True, "provider": provider, "sessionId": req.sessionId})

        return StreamingResponse(
            gen(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/chat/complete", response_model=ChatCompleteResponse)
    def post_chat_complete(req: ChatRequest) -> ChatCompleteResponse:
        text, provider = chat.complete(req)
        return ChatCompleteResponse(sessionId=req.sessionId, text=text, provider=provider)

    @app.delete("/chat/{session_id}", response_model=DeleteSessionResponse)
    def delete_chat(session_id: str) -> DeleteSessionResponse:
        return DeleteSessionResponse(sessionId=session_id, discarded=chat.delete_session(session_id))

    @app.get("/audit/last-payload")
    def audit_last_payload() -> dict:
        """시연 ② "AI가 받은 정보 보기": 마지막 LLM 호출에 실제로 전달된 system·messages·model (템플릿이면 그 입력)."""
        if llm.LAST_PAYLOAD is None:
            return {"available": False, "kind": None, "provider": None, "model": None, "payload": None}
        return {"available": True, **llm.LAST_PAYLOAD}

    return app


app = create_app()
