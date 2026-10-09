"""/chat — 세션은 메모리 dict 에만 있고 DELETE, 30분 무활동, 상한 200개 초과, 프로세스 종료 시 사라진다 (불변 조건 6, F20).

- 자유입력 질문은 LLM·세션·감사 기록에 넣기 전에 주민등록번호·전화번호·계좌번호·금액을 "[가림]" 으로 바꾼다 (F21).
- 채팅 답변은 인용 검증기를 거치지 않는 설명이다. 응답에는 판정 출처(eligibilitySource)와 "판정이 아님" 안내를 붙이고,
  LLM 답변이 부적격 제도를 "받으실 수 있습니다" 처럼 말하면 템플릿 답변으로 바꾸거나(비스트리밍) 바로잡는 문장을 덧붙인다(스트리밍) (F22).
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass

from . import llm
from .prompts import build_chat_context_block, cached_system_blocks
from .retriever import PolicyStore, get_store
from .schemas import ChatRequest
from .template import chunk_text, template_chat_answer

log = logging.getLogger("dbp_ai.chat")

MAX_HISTORY_MESSAGES = 20  # user+assistant 합계. 넘치면 앞에서 버린다.
MAX_SESSIONS = 200  # 넘치면 가장 오래 쓰지 않은 세션부터 버린다.
SESSION_TTL_S = 30 * 60.0  # 마지막 사용 후 30분이 지나면 버린다.
MAX_SESSION_AUDITS = 20
STREAM_CUT_NOTICE = "\n(연결이 끊겨 답변이 여기서 멈췄습니다. 다시 물어봐 주세요.)"

# ---- 자유입력 마스킹 (F21) ----

MASK = "[가림]"
# 가렸다는 사실은 지갑이 masked 로 따로 표시한다. 답에는 다음부터 말하지 않아도 된다는 안내만 붙인다.
MASK_NOTICE = "(주민등록번호·전화번호·계좌번호·금액 같은 정보는 말씀하지 않으셔도 됩니다.)\n"
_PII_PATTERNS = [
    re.compile(r"\d{6}\s*-?\s*\d{7}"),  # 주민등록번호
    re.compile(r"(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)"),  # 휴대폰·유선 전화번호
    # 금액: "250만원", "1,200,000원", "1억 2천만 원", "3천원"
    re.compile(r"\d[\d,]*(?:\.\d+)?(?:\s*(?:억|천만|백만|십만|만|천|백)(?:\s*\d[\d,]*(?:\.\d+)?)?)*\s*원"),
    # '원' 없이 말하는 금액: "월 소득 250만", "연봉 3500만", "1억 2천만"
    re.compile(r"\d[\d,]*(?:\.\d+)?\s*(?:억|천만|백만|십만|만)(?:\s*\d[\d,]*(?:\.\d+)?\s*(?:천만|백만|십만|만|천))*"),
    re.compile(r"₩\s*\d[\d,]*"),  # "₩2,500,000"
    re.compile(r"\d{2,6}(?:[-\s]\d{2,8}){2,}"),  # 하이픈·공백으로 끊은 계좌번호류 (sub 에서 숫자 10자리 이상만)
    re.compile(r"\d{8,}"),  # 끊지 않은 긴 숫자열 (계좌·카드 번호류)
]


def mask_pii(text: str) -> tuple[str, bool]:
    """주민등록번호·전화번호·계좌번호류·금액을 [가림] 으로 바꾼다. (가린 문장, 가린 것이 있는지)."""
    masked = False

    def sub(m: re.Match) -> str:
        nonlocal masked
        s = m.group(0)
        if ("-" in s or " " in s) and not any(u in s for u in "억만천₩"):  # 단위가 붙은 금액은 공백이 있어도 가린다
            digits = sum(c.isdigit() for c in s)
            # 하이픈·공백으로 끊은 숫자는 날짜(2026-09-14, 8자리)와 구별하려고 10자리 이상만 계좌로 본다
            if not s.endswith("원") and not _is_phone_or_rrn(s) and digits < 10:
                return s
        masked = True
        return MASK

    out = text
    for pat in _PII_PATTERNS:
        out = pat.sub(sub, out)
    return out, masked


def _is_phone_or_rrn(s: str) -> bool:
    return bool(_PII_PATTERNS[0].fullmatch(s) or _PII_PATTERNS[1].fullmatch(s))


def masked_request(req: ChatRequest) -> tuple[ChatRequest, bool]:
    text, masked = mask_pii(req.message)
    return (req.model_copy(update={"message": text}) if masked else req), masked


# ---- 세션 (F20) ----

_SESSIONS: OrderedDict[str, dict] = OrderedDict()
_LOCK = threading.Lock()
_clock = time.monotonic  # 테스트에서 바꿔 끼운다


def _discard(session_id: str) -> bool:
    s = _SESSIONS.pop(session_id, None)
    if s is None:
        return False
    llm.discard_audits(s.get("auditIds", []))
    return True


def _purge(now: float) -> None:
    for k in [k for k, s in _SESSIONS.items() if now - s["touchedAt"] > SESSION_TTL_S]:
        _discard(k)


def get_session(session_id: str) -> dict:
    with _LOCK:
        now = _clock()
        _purge(now)
        s = _SESSIONS.get(session_id)
        if s is None:
            while len(_SESSIONS) >= MAX_SESSIONS:
                _discard(next(iter(_SESSIONS)))
            s = {"messages": [], "auditIds": [], "touchedAt": now}
            _SESSIONS[session_id] = s
        else:
            s["touchedAt"] = now
            _SESSIONS.move_to_end(session_id)
        return s


def delete_session(session_id: str) -> bool:
    """세션과 그 세션의 감사 기록을 함께 버린다."""
    with _LOCK:
        return _discard(session_id)


def session_count() -> int:
    with _LOCK:
        _purge(_clock())
        return len(_SESSIONS)


def reset_sessions() -> None:
    with _LOCK:
        _SESSIONS.clear()


def _append_turn(session: dict, user_text: str, assistant_text: str, audit_id: str) -> None:
    with _LOCK:
        session["messages"].append({"role": "user", "content": user_text})
        session["messages"].append({"role": "assistant", "content": assistant_text})
        if len(session["messages"]) > MAX_HISTORY_MESSAGES:
            del session["messages"][: len(session["messages"]) - MAX_HISTORY_MESSAGES]
        session["auditIds"] = [*session["auditIds"], audit_id][-MAX_SESSION_AUDITS:]
        session["touchedAt"] = _clock()


# ---- 부적격 제도 긍정 표현 감지 (F22) ----

_AFFIRMATIVE = (
    "받을 수 있습니다", "받으실 수 있습니다", "신청하실 수 있습니다", "신청할 수 있습니다", "신청 가능",
    "대상입니다", "기준을 충족", "해당합니다", "적격입니다",
)
_SENTENCE_RE = re.compile(r"[^.!?\n。]+")


def contradicted_policies(text: str, req: ChatRequest, store: PolicyStore) -> list[str]:
    """규칙 엔진이 부적격으로 판정한 제도를 같은 문장에서 긍정 표현과 함께 언급하면 그 policyId 들."""
    ineligible = {r.policyId for r in req.ruleResults if not r.eligible and r.policyId in store.by_id}
    hits: list[str] = []
    for sentence in _SENTENCE_RE.findall(text):
        if not any(a in sentence for a in _AFFIRMATIVE):
            continue
        hits += [pid for pid in store.match_policies(sentence) if pid in ineligible and pid not in hits]
    return hits


def _correction(pids: list[str], store: PolicyStore) -> str:
    names = ", ".join(store.by_id[p]["name"] for p in pids)
    return f"\n(바로잡습니다: {names} — 규칙 엔진 판정 결과 현재 기준에는 해당하지 않습니다. 판정은 규칙 엔진 결과만 따릅니다.)"


# ---- 답변 ----


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


def _template_answer(req: ChatRequest, audit_id: str) -> str:
    store = get_store()
    llm.record_template_inputs("chat", {
        "categoricalProfile": req.categoricalProfile.model_dump(),
        "ruleResults": [r.model_dump() for r in req.ruleResults],
        "message": req.message,
    }, audit_id=audit_id)
    return template_chat_answer(req.message, req.categoricalProfile, req.ruleResults, store)


@dataclass(frozen=True)
class ChatTurn:
    text: str
    provider: str
    masked: bool
    auditId: str


def complete(req: ChatRequest, audit_id: str | None = None) -> ChatTurn:
    """비스트리밍 답변. 질문은 마스킹한 뒤에만 LLM·세션·감사 기록으로 간다."""
    audit_id = audit_id or llm.new_audit_id()
    req, masked = masked_request(req)
    session = get_session(req.sessionId)
    text: str | None = None
    used = "template"
    if llm.provider() == "anthropic":
        try:
            text = llm.llm_call("chat", build_chat_payload(req, session, llm.model_name()), audit_id=audit_id)
            used = "anthropic"
        except Exception as e:  # noqa: BLE001
            log.warning("chat: llm failed, falling back to template error=%s", llm.describe_error(e))
        if text is not None:
            bad = contradicted_policies(text, req, get_store())
            if bad:
                log.info("chat: llm answer contradicts rule engine for %s, using template", bad)
                text, used = None, "template"
    if text is None:
        text = _template_answer(req, audit_id)
    _append_turn(session, req.message, text, audit_id)
    return ChatTurn(text=(MASK_NOTICE + text) if masked else text, provider=used, masked=masked, auditId=audit_id)


def stream(req: ChatRequest, audit_id: str | None = None) -> Iterator[tuple[str, str]]:
    """텍스트 델타를 (delta, provider) 로 흘려보낸다. 실패 시 템플릿 답변으로 이어 간다."""
    audit_id = audit_id or llm.new_audit_id()
    req, masked = masked_request(req)
    if masked:
        yield MASK_NOTICE, "template"
    session = get_session(req.sessionId)
    parts: list[str] = []
    used = "template"
    if llm.provider() == "anthropic":
        try:
            payload = build_chat_payload(req, session, llm.model_name())
            for delta in llm.llm_call("chat_stream", payload, audit_id=audit_id):
                parts.append(delta)
                yield delta, "anthropic"
            used = "anthropic"
        except Exception as e:  # noqa: BLE001
            log.warning("chat: stream failed after %d delta(s), error=%s", len(parts), llm.describe_error(e))
            if parts:
                parts.append(STREAM_CUT_NOTICE)
                yield STREAM_CUT_NOTICE, "anthropic"
                used = "anthropic"
        if parts:
            store = get_store()
            bad = contradicted_policies("".join(parts), req, store)
            if bad:
                note = _correction(bad, store)
                parts.append(note)
                yield note, used
    if not parts:
        text = _template_answer(req, audit_id)
        for chunk in chunk_text(text):
            parts.append(chunk)
            yield chunk, "template"
    _append_turn(session, req.message, "".join(parts), audit_id)
    log.info("chat: turn done provider=%s session_messages=%d", used, len(session["messages"]))
