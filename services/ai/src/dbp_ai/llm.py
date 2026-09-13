"""LLM 호출 경계 — 실제 SDK 호출은 이 모듈의 `llm_call(kind, payload)` 한 곳에서만 일어난다.

- `llm_call` 은 SDK 를 부르기 직전에 `LAST_PAYLOAD` 에 페이로드를 그대로 기록한다
  (`GET /audit/last-payload` 와 PII 차단 테스트의 후킹 지점).
- payload 는 JSON 직렬화 가능한 dict 이며 SDK 에 그대로 펼쳐 넘긴다.
  (`output_format` 만 이름 → Pydantic 클래스 로 바꾼다.)
- 로그에는 provider·model·kind·latency·토큰 수만 남긴다. 프롬프트/응답 본문은 절대 남기지 않는다.
- 어떤 오류도 밖으로 터뜨리지 않는 것은 호출자의 책임이다 (호출자는 예외를 잡고 템플릿으로 폴백한다).
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Iterator

from .config import Settings
from .schemas import RecommendationResponse

log = logging.getLogger("dbp_ai.llm")

OUTPUT_FORMATS: dict[str, type] = {"RecommendationResponse": RecommendationResponse}

# 마지막으로 LLM(또는 템플릿)에 전달된 입력. 메모리에만 있고, 프로세스가 끝나면 사라진다.
LAST_PAYLOAD: dict | None = None

_client: Any = None
_client_override: Any = None


class LLMError(RuntimeError):
    """SDK 호출은 됐지만 쓸 수 있는 결과가 없을 때."""


class LLMRefusal(LLMError):
    """stop_reason == "refusal"."""


def set_client(client: Any) -> None:
    """테스트용: 가짜 클라이언트 주입 (messages.parse / create / stream 인터페이스)."""
    global _client_override
    _client_override = client


def reset() -> None:
    global LAST_PAYLOAD, _client, _client_override
    LAST_PAYLOAD = None
    _client = None
    _client_override = None


def settings() -> Settings:
    return Settings.from_env()


def provider() -> str:
    """실제로 쓰일 provider. 키가 없거나 LLM_PROVIDER=template 이면 template."""
    s = settings()
    if s.provider == "template":
        return "template"
    if _client_override is not None or s.api_key:
        return "anthropic"
    return "template"


def model_name() -> str:
    return settings().model


def _get_client() -> Any:
    if _client_override is not None:
        return _client_override
    global _client
    if _client is None:
        import anthropic

        s = settings()
        _client = anthropic.Anthropic(api_key=s.api_key, timeout=s.timeout_s, max_retries=1)
    return _client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def record_payload(kind: str, provider_name: str, payload: dict, model: str | None) -> None:
    global LAST_PAYLOAD
    LAST_PAYLOAD = {"kind": kind, "provider": provider_name, "model": model, "recordedAt": _now(), "payload": payload}


def record_template_inputs(kind: str, inputs: dict) -> None:
    record_payload(kind, "template", {"templateInputs": inputs}, model=None)


def describe_error(e: BaseException) -> str:
    """로그용 오류 요약 — 클래스명과 상태 코드만 (메시지 본문은 남기지 않는다)."""
    status = getattr(e, "status_code", None)
    return f"{type(e).__name__}" + (f"[{status}]" if status else "")


def _usage(resp: Any) -> dict[str, int]:
    u = getattr(resp, "usage", None)
    keys = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    return {k: int(getattr(u, k, 0) or 0) for k in keys}


def _log_call(kind: str, model: str, t0: float, resp: Any) -> None:
    u = _usage(resp)
    log.info(
        "llm kind=%s provider=anthropic model=%s latency_ms=%d stop_reason=%s input_tokens=%d output_tokens=%d "
        "cache_read_input_tokens=%d cache_creation_input_tokens=%d",
        kind, model, int((time.perf_counter() - t0) * 1000), getattr(resp, "stop_reason", None),
        u["input_tokens"], u["output_tokens"], u["cache_read_input_tokens"], u["cache_creation_input_tokens"],
    )


def llm_call(kind: str, payload: dict) -> Any:
    """단일 LLM 경계. kind: "recommend" → RecommendationResponse, "chat" → str, "chat_stream" → Iterator[str]."""
    record_payload(kind, "anthropic", payload, model=payload.get("model"))
    client = _get_client()
    kwargs = dict(payload)

    if kind == "recommend":
        fmt = OUTPUT_FORMATS[kwargs.pop("output_format")]
        t0 = time.perf_counter()
        resp = client.messages.parse(**kwargs, output_format=fmt)
        _log_call(kind, kwargs["model"], t0, resp)
        if resp.stop_reason == "refusal":
            raise LLMRefusal("refusal")
        parsed = resp.parsed_output
        if parsed is None:
            raise LLMError(f"no parsed output (stop_reason={resp.stop_reason})")
        return parsed

    if kind == "chat":
        t0 = time.perf_counter()
        resp = client.messages.create(**kwargs)
        _log_call(kind, kwargs["model"], t0, resp)
        if resp.stop_reason == "refusal":
            raise LLMRefusal("refusal")
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        if not text.strip():
            raise LLMError(f"empty text (stop_reason={resp.stop_reason})")
        return text

    if kind == "chat_stream":
        return _stream(client, kwargs)

    raise ValueError(f"unknown llm_call kind: {kind}")


def _stream(client: Any, kwargs: dict) -> Iterator[str]:
    t0 = time.perf_counter()
    with client.messages.stream(**kwargs) as stream:
        for event in stream:
            if getattr(event, "type", None) == "text" and event.text:
                yield event.text
        final = stream.get_final_message()
    _log_call("chat_stream", kwargs["model"], t0, final)
    if final.stop_reason == "refusal":
        raise LLMRefusal("refusal")
