"""공용 픽스처: 격리(provider=template, 세션·LAST_PAYLOAD 초기화), 페르소나 C-001, 가짜 Anthropic 클라이언트."""
from __future__ import annotations

import copy
import json
from datetime import date

import pytest
from dbp_ai import chat, llm
from dbp_ai.app import app
from dbp_ai.retriever import get_store
from dbp_rules import categorical_profile, evaluate_claims, evaluate_policies, load_bundle, repo_root
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "template")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("LLM_MODEL", "claude-opus-5")
    llm.reset()
    chat.reset_sessions()
    yield
    llm.reset()
    chat.reset_sessions()


@pytest.fixture
def anthropic_env(monkeypatch):
    """provider=anthropic 로 전환. 실제 네트워크는 절대 타지 않도록 각 테스트가 가짜 클라이언트나 가짜 llm_call 을 꽂는다."""
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(scope="session")
def persona():
    """C-001 (시연 페르소나) 의 규칙 엔진 결과를 dbp_rules 로 직접 만든다."""
    root = repo_root()
    citizens = json.loads((root / "data/citizens.json").read_text(encoding="utf-8"))["citizens"]
    c = next(x for x in citizens if x["citizenId"] == "C-001")
    bundle = load_bundle()
    claims = evaluate_claims(bundle, c, date(2026, 9, 14))
    policies = evaluate_policies(bundle, claims)
    store = get_store()
    rule_results = []
    for pid, eligible in policies.items():
        req = store.by_id[pid]["requiredClaims"]
        matched = [rc["claim"] for rc in req if claims.get(rc["claim"]) == rc["expected"]]
        rule_results.append({"policyId": pid, "eligible": eligible, "matchedClaims": matched})
    return {
        "citizen": c,
        "claims": claims,
        "policies": policies,
        "categoricalProfile": categorical_profile(claims, c["householdSize"]),
        "ruleResults": rule_results,
        "eligibleIds": {pid for pid, v in policies.items() if v},
    }


@pytest.fixture
def recommend_body(persona):
    # persona 는 session 범위이므로 테스트가 마음껏 고칠 수 있게 깊은 복사본을 준다
    return copy.deepcopy({"categoricalProfile": persona["categoricalProfile"],
                          "ruleResults": persona["ruleResults"], "locale": "ko"})


@pytest.fixture
def chat_body(persona):
    def make(message: str, session_id: str = "s-test"):
        return copy.deepcopy({"sessionId": session_id, "message": message,
                              "categoricalProfile": persona["categoricalProfile"],
                              "ruleResults": persona["ruleResults"]})
    return make
