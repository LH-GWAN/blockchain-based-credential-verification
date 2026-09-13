"""감사 엔드포인트, 헬스, 로그 위생."""
import logging

from ai_testing import FakeAnthropic
from dbp_ai import llm
from dbp_ai.schemas import LLMRecommendation, RecommendationResponse

LLM_OUT = RecommendationResponse(recommendations=[LLMRecommendation(
    policyId="near-poor", headline="차상위계층 확인", explanation="규칙 엔진 판정 결과 신청 기준을 충족합니다.",
    citations=["near-poor-c1"], nextSteps="행정복지센터 방문")])


def test_audit_is_empty_before_any_call(client):
    r = client.get("/audit/last-payload")
    assert r.status_code == 200 and r.json()["available"] is False


def test_audit_reflects_exact_llm_payload(client, recommend_body, anthropic_env):
    fake = FakeAnthropic(parsed_output=LLM_OUT)
    llm.set_client(fake)
    client.post("/recommend", json=recommend_body)
    _, kw = fake.calls[0]

    audit = client.get("/audit/last-payload").json()
    assert audit["available"] is True
    assert audit["kind"] == "recommend" and audit["provider"] == "anthropic" and audit["model"] == "claude-opus-5"
    assert audit["payload"]["system"] == kw["system"]
    assert audit["payload"]["messages"] == kw["messages"]
    assert audit["payload"]["model"] == kw["model"]
    assert audit["payload"]["output_format"] == "RecommendationResponse"


def test_audit_reflects_template_inputs(client, recommend_body, persona):
    client.post("/recommend", json=recommend_body)
    audit = client.get("/audit/last-payload").json()
    assert audit["provider"] == "template" and audit["kind"] == "recommend"
    inputs = audit["payload"]["templateInputs"]
    assert inputs["categoricalProfile"] == persona["categoricalProfile"]
    assert set(inputs["candidatePolicyIds"]) == persona["eligibleIds"]
    assert set(inputs.keys()) == {"categoricalProfile", "ruleResults", "candidatePolicyIds"}


def test_audit_tracks_latest_call(client, recommend_body, chat_body, anthropic_env):
    fake = FakeAnthropic(parsed_output=LLM_OUT, text="안내해 드립니다.")
    llm.set_client(fake)
    client.post("/recommend", json=recommend_body)
    client.post("/chat/complete", json=chat_body("기초연금 신청 방법 알려 주세요"))
    audit = client.get("/audit/last-payload").json()
    assert audit["kind"] == "chat"
    assert audit["payload"]["messages"][-1]["content"] == "기초연금 신청 방법 알려 주세요"


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
