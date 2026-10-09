"""감사 엔드포인트(auditId 별), 헬스, 로그 위생, 바인딩·CORS·LLM 클라이언트 설정."""
import logging

import pytest
from ai_testing import FakeAnthropic, parse_sse
from dbp_ai import chat, llm
from dbp_ai.config import DEFAULT_ALLOWED_ORIGINS, Settings, allowed_origins
from dbp_ai.schemas import LLMRecommendation, RecommendationResponse

LLM_OUT = RecommendationResponse(recommendations=[LLMRecommendation(
    policyId="near-poor", headline="차상위계층 확인", explanation="규칙 엔진 판정 결과 신청 기준을 충족합니다.",
    citations=["near-poor-c1"], nextSteps="행정복지센터 방문")])


def test_last_payload_endpoint_is_gone(client, chat_body):
    """F12: 프로세스 전체의 '마지막 기록' 은 다른 사람의 질문을 돌려준다 → 410, auditId 로만 조회."""
    client.post("/chat/complete", json=chat_body("기초연금 신청 방법 알려 주세요"))
    r = client.get("/audit/last-payload")
    assert r.status_code == 410 and r.json() == {"detail": "USE_AUDIT_ID"}


def test_unknown_audit_id_is_404(client):
    r = client.get("/audit/not-a-real-id")
    assert r.status_code == 404 and r.json()["detail"] == "AUDIT_UNKNOWN"


def test_audit_reflects_exact_llm_payload(client, recommend_body, anthropic_env):
    fake = FakeAnthropic(parsed_output=LLM_OUT)
    llm.set_client(fake)
    audit_id = client.post("/recommend", json=recommend_body).json()["auditId"]
    _, kw = fake.calls[0]

    audit = client.get(f"/audit/{audit_id}").json()
    assert audit["available"] is True and audit["auditId"] == audit_id
    assert audit["kind"] == "recommend" and audit["provider"] == "anthropic" and audit["model"] == "claude-opus-5"
    assert audit["payload"]["system"] == kw["system"]
    assert audit["payload"]["messages"] == kw["messages"]
    assert audit["payload"]["model"] == kw["model"]
    assert audit["payload"]["output_format"] == "RecommendationResponse"


def test_audit_reflects_template_inputs(client, recommend_body, persona):
    audit_id = client.post("/recommend", json=recommend_body).json()["auditId"]
    audit = client.get(f"/audit/{audit_id}").json()
    assert audit["provider"] == "template" and audit["kind"] == "recommend"
    inputs = audit["payload"]["templateInputs"]
    assert inputs["categoricalProfile"] == persona["categoricalProfile"]
    assert set(inputs["candidatePolicyIds"]) == persona["eligibleIds"]
    assert set(inputs.keys()) == {"categoricalProfile", "ruleResults", "candidatePolicyIds"}


def test_audit_is_per_call_not_last_call(client, recommend_body, chat_body, anthropic_env):
    """다른 사용자가 나중에 채팅해도, 내 auditId 는 내 요청의 입력만 돌려준다."""
    fake = FakeAnthropic(parsed_output=LLM_OUT, text="안내해 드립니다.")
    llm.set_client(fake)
    mine = client.post("/recommend", json=recommend_body).json()["auditId"]
    other = client.post("/chat/complete", json=chat_body("기초연금 신청 방법 알려 주세요", "s-other")).json()
    assert other["auditId"] != mine

    a = client.get(f"/audit/{mine}").json()
    assert a["kind"] == "recommend"
    assert "기초연금 신청 방법" not in str(a["payload"])
    b = client.get(f"/audit/{other['auditId']}").json()
    assert b["kind"] == "chat"
    assert b["payload"]["messages"][-1]["content"] == "기초연금 신청 방법 알려 주세요"


def test_audit_ids_are_random_and_unguessable(client, recommend_body):
    ids = {client.post("/recommend", json=recommend_body).json()["auditId"] for _ in range(5)}
    assert len(ids) == 5 and all(len(i) >= 20 for i in ids)


def test_stream_audit_id_header_matches_done_event(client, chat_body):
    r = client.post("/chat", json=chat_body("기초연금은 어떻게 신청하나요?", "s-hdr"))
    audit_id = r.headers["x-audit-id"]
    assert parse_sse(r.text)[-1]["auditId"] == audit_id
    audit = client.get(f"/audit/{audit_id}").json()
    assert audit["kind"] == "chat" and audit["payload"]["templateInputs"]["message"] == "기초연금은 어떻게 신청하나요?"


def test_audit_expires_after_ttl(client, recommend_body, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(llm, "_clock", lambda: now[0])
    audit_id = client.post("/recommend", json=recommend_body).json()["auditId"]
    now[0] += llm.AUDIT_TTL_S - 1
    assert client.get(f"/audit/{audit_id}").status_code == 200
    now[0] += 2
    assert client.get(f"/audit/{audit_id}").status_code == 404


def test_audit_store_is_capped():
    first = llm.record_template_inputs("recommend", {"n": 0})
    for i in range(llm.AUDIT_CAP):
        llm.record_template_inputs("recommend", {"n": i + 1})
    assert llm.audit_count() == llm.AUDIT_CAP
    assert llm.get_audit(first) is None  # 가장 오래된 기록부터 버린다


def test_delete_session_discards_its_audits(client, chat_body):
    audit_id = client.post("/chat/complete", json=chat_body("기초연금 알려 주세요", "s-del")).json()["auditId"]
    assert client.get(f"/audit/{audit_id}").status_code == 200
    client.delete("/chat/s-del")
    assert client.get(f"/audit/{audit_id}").status_code == 404
    assert chat.session_count() == 0


def test_health_template(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "provider": "template", "model": "claude-opus-5"}


def test_health_anthropic(client, anthropic_env, monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "claude-opus-5")
    assert client.get("/health").json() == {"ok": True, "provider": "anthropic", "model": "claude-opus-5"}


def test_logs_never_contain_prompt_or_response_bodies(client, recommend_body, anthropic_env, caplog):
    fake = FakeAnthropic(parsed_output=LLM_OUT)
    llm.set_client(fake)
    with caplog.at_level(logging.DEBUG, logger="dbp_ai"):
        client.post("/recommend", json=recommend_body)
    text = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "latency_ms=" in text and "input_tokens=1200" in text and "model=claude-opus-5" in text
    _, kw = fake.calls[0]
    assert "[절대 규칙]" not in text
    assert kw["messages"][0]["content"][:40] not in text
    assert LLM_OUT.recommendations[0].explanation not in text
    assert "범주 프로필" not in text


# ---- 바인딩·CORS (기본은 루프백·지갑 출처만) ----


def test_default_bind_is_loopback(monkeypatch):
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.delenv("AI_HOST", raising=False)
    assert Settings.from_env().host == "127.0.0.1"
    monkeypatch.setenv("HOST", "0.0.0.0")
    assert Settings.from_env().host == "0.0.0.0"


def test_allowed_origins_from_env(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    assert allowed_origins() == DEFAULT_ALLOWED_ORIGINS.split(",")
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://a.test:3000, http://b.test")
    assert allowed_origins() == ["http://a.test:3000", "http://b.test"]


@pytest.mark.parametrize("origin,allowed", [
    ("http://localhost:3000", True), ("http://127.0.0.1:3010", True), ("http://evil.example", False),
])
def test_cors_only_for_known_origins(client, origin, allowed):
    r = client.get("/health", headers={"Origin": origin})
    assert (r.headers.get("access-control-allow-origin") == origin) is allowed


def test_cors_exposes_audit_header(client, chat_body):
    r = client.post("/chat", json=chat_body("안녕하세요", "s-cors"), headers={"Origin": "http://localhost:3000"})
    assert "x-audit-id" in r.headers.get("access-control-expose-headers", "").lower()


# ---- LLM 클라이언트: 짧은 타임아웃, 재시도 없음 (F18) ----


def test_llm_client_timeout_and_no_retries(anthropic_env, monkeypatch):
    import anthropic

    seen = {}

    def fake_ctor(**kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.delenv("LLM_TIMEOUT_S", raising=False)
    monkeypatch.setattr(anthropic, "Anthropic", fake_ctor)
    llm._get_client()
    assert seen["timeout"] == 25.0 and seen["max_retries"] == 0
