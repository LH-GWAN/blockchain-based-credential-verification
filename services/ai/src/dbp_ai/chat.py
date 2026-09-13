"""/chat — 세션은 메모리 dict 에만 있고 DELETE 또는 프로세스 종료 시 사라진다 (불변 조건 6)."""
from __future__ import annotations

import logging
from collections.abc import Iterator

from . import llm
from .prompts import build_chat_context_block, cached_system_blocks
from .retriever import get_store
from .schemas import ChatRequest
from .template import chunk_text, template_chat_answer

log = logging.getLogger("dbp_ai.chat")

MAX_HISTORY_MESSAGES = 20  # user+assistant 합계. 넘치면 앞에서 버린다.
STREAM_CUT_NOTICE = "\n(연결이 끊겨 답변이 여기서 멈췄습니다. 다시 물어봐 주세요.)"

_SESSIONS: dict[str, dict] = {}


def get_session(session_id: str) -> dict:
    return _SESSIONS.setdefault(session_id, {"messages": []})


def delete_session(session_id: str) -> bool:
    return _SESSIONS.pop(session_id, None) is not None


def session_count() -> int:
    return len(_SESSIONS)


def reset_sessions() -> None:
    _SESSIONS.clear()


def _append_turn(session: dict, user_text: str, assistant_text: str) -> None:
    session["messages"].append({"role": "user", "content": user_text})
    session["messages"].append({"role": "assistant", "content": assistant_text})
    if len(session["messages"]) > MAX_HISTORY_MESSAGES:
        del session["messages"][: len(session["messages"]) - MAX_HISTORY_MESSAGES]


def build_chat_payload(req: ChatRequest, session: dict, model: str) -> dict:
    store = get_store()
    return {
        "model": model,
        "max_tokens": 4096,
        "system": [*cached_system_blocks(), build_chat_context_block(req.categoricalProfile, req.ruleResults, store)],
        "messages": [*session["messages"], {"role": "user", "content": req.message}],
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "medium"},
    }


def _template_answer(req: ChatRequest) -> str:
    store = get_store()
    llm.record_template_inputs("chat", {
        "categoricalProfile": req.categoricalProfile.model_dump(),
        "ruleResults": [r.model_dump() for r in req.ruleResults],
        "message": req.message,
    })
    return template_chat_answer(req.message, req.categoricalProfile, req.ruleResults, store)


def complete(req: ChatRequest) -> tuple[str, str]:
    """비스트리밍 답변. (text, provider) 를 돌려준다."""
    session = get_session(req.sessionId)
    text: str | None = None
    used = "template"
    if llm.provider() == "anthropic":
        try:
            text = llm.llm_call("chat", build_chat_payload(req, session, llm.model_name()))
            used = "anthropic"
        except Exception as e:  # noqa: BLE001
            log.warning("chat: llm failed, falling back to template error=%s", llm.describe_error(e))
    if text is None:
        text = _template_answer(req)
    _append_turn(session, req.message, text)
    return text, used


def stream(req: ChatRequest) -> Iterator[tuple[str, str]]:
    """텍스트 델타를 (delta, provider) 로 흘려보낸다. 실패 시 템플릿 답변으로 이어 간다."""
    session = get_session(req.sessionId)
    parts: list[str] = []
    used = "template"
    if llm.provider() == "anthropic":
        try:
            for delta in llm.llm_call("chat_stream", build_chat_payload(req, session, llm.model_name())):
                parts.append(delta)
                yield delta, "anthropic"
            used = "anthropic"
        except Exception as e:  # noqa: BLE001
            log.warning("chat: stream failed after %d delta(s), error=%s", len(parts), llm.describe_error(e))
            if parts:
                parts.append(STREAM_CUT_NOTICE)
                yield STREAM_CUT_NOTICE, "anthropic"
                used = "anthropic"
    if not parts:
        text = _template_answer(req)
        for chunk in chunk_text(text):
            parts.append(chunk)
            yield chunk, "template"
    _append_turn(session, req.message, "".join(parts))
    log.info("chat: turn done provider=%s session_messages=%d", used, len(session["messages"]))
