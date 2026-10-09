"""LLM 호출 경계 — 실제 SDK 호출은 이 모듈의 `llm_call(kind, payload)` 한 곳에서만 일어난다.

- `llm_call` 은 SDK 를 부르기 직전에 페이로드를 감사 저장소에 무작위 auditId 로 그대로 기록한다
  (`GET /audit/{auditId}` 와 PII 차단 테스트의 후킹 지점). 저장소는 프로세스 메모리에만 있고
  최대 100건·10분만 보관한다. auditId 를 받은 요청자만 자기 기록을 볼 수 있다 (F12).
- payload 는 JSON 직렬화 가능한 dict 이며 SDK 에 그대로 펼쳐 넘긴다.
  (`output_format` 만 이름 → Pydantic 클래스 로 바꾼다.)
- 로그에는 provider·model·kind·latency·토큰 수만 남긴다. 프롬프트/응답 본문은 절대 남기지 않는다.
- 어떤 오류도 밖으로 터뜨리지 않는 것은 호출자의 책임이다 (호출자는 예외를 잡고 템플릿으로 폴백한다).
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from .config import Settings
from .schemas import RecommendationResponse

log = logging.getLogger("dbp_ai.llm")

OUTPUT_FORMATS: dict[str, type] = {"RecommendationResponse": RecommendationResponse}

# LLM(또는 템플릿)에 전달된 입력의 감사 기록. auditId → (만료 시각, 기록). 메모리에만 있고, 프로세스가 끝나면 사라진다.
AUDIT_CAP = 100
AUDIT_TTL_S = 600.0
_AUDIT: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_AUDIT_LOCK = threading.Lock()
_clock = time.monotonic  # 테스트에서 바꿔 끼운다

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
    global _client, _client_override
    with _AUDIT_LOCK:
        _AUDIT.clear()
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
        # 재시도 없이 짧게 끊고 템플릿으로 폴백한다 — 지갑 타임아웃보다 먼저 답이 나가야 한다 (F18)
        _client = anthropic.Anthropic(api_key=s.api_key, timeout=s.timeout_s, max_retries=0)
    return _client


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_audit_id() -> str:
    return secrets.token_urlsafe(16)


def _purge_audit(now: float) -> None:
    for k in [k for k, (exp, _) in _AUDIT.items() if exp <= now]:
        del _AUDIT[k]
    while len(_AUDIT) > AUDIT_CAP:
        _AUDIT.popitem(last=False)


def record_payload(kind: str, provider_name: str, payload: dict, model: str | None,
                   audit_id: str | None = None) -> str:
    """감사 기록을 남기고 auditId 를 돌려준다. 같은 auditId 로 다시 기록하면 덮어쓴다 (LLM 실패 → 템플릿 폴백)."""
    audit_id = audit_id or new_audit_id()
    record = {"kind": kind, "provider": provider_name, "model": model, "recordedAt": _now(), "payload": payload}
    with _AUDIT_LOCK:
        now = _clock()
        _AUDIT[audit_id] = (now + AUDIT_TTL_S, record)
        _AUDIT.move_to_end(audit_id)
        _purge_audit(now)
    return audit_id


def record_template_inputs(kind: str, inputs: dict, audit_id: str | None = None) -> str:
    return record_payload(kind, "template", {"templateInputs": inputs}, model=None, audit_id=audit_id)


def get_audit(audit_id: str) -> dict | None:
    """auditId 의 기록. 없거나 만료됐으면 None."""
    with _AUDIT_LOCK:
        _purge_audit(_clock())
        hit = _AUDIT.get(audit_id)
        return hit[1] if hit else None


def discard_audits(audit_ids: list[str]) -> None:
    """세션 폐기 시 그 세션의 감사 기록도 함께 지운다."""
    with _AUDIT_LOCK:
        for k in audit_ids:
            _AUDIT.pop(k, None)


def audit_count() -> int:
    with _AUDIT_LOCK:
        _purge_audit(_clock())
        return len(_AUDIT)


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


def llm_call(kind: str, payload: dict, audit_id: str | None = None) -> Any:
    """단일 LLM 경계. kind: "recommend" → RecommendationResponse, "chat" → str, "chat_stream" → Iterator[str].

    audit_id 를 주면 그 키로 감사 기록을 남긴다 (호출자가 응답에 같은 auditId 를 실어 보낸다).
    """
    record_payload(kind, "anthropic", payload, model=payload.get("model"), audit_id=audit_id)
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
