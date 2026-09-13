"""공용 픽스처: 격리(provider=template, 세션·LAST_PAYLOAD 초기화), 페르소나 C-001, 가짜 Anthropic 클라이언트."""
from __future__ import annotations

import copy
import json
from contextlib import contextmanager
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from dbp_ai import chat, llm
from dbp_ai.app import app
from dbp_ai.retriever import get_store
from dbp_rules import categorical_profile, evaluate_claims, evaluate_policies, load_bundle, repo_root

INELIGIBLE_FOR_PERSONA = {"nbl-livelihood", "nbl-education", "energy-voucher"}
PROBE_MESSAGE = "대구 청년 행복수당 받을 수 있나요?"
VERDICT_MARKERS = [
    "받을 수 있습니다", "받으실 수 있습니다", "신청하실 수 있습니다", "신청할 수 있습니다", "기준을 충족",
    "해당하지 않습니다", "해당합니다", "적격", "부적격", "대상입니다", "대상이 아닙니다",
]


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


# ---- 가짜 Anthropic 클라이언트 ----


def fake_usage():
    return SimpleNamespace(input_tokens=1200, output_tokens=300, cache_read_input_tokens=1000, cache_creation_input_tokens=0)


class FakeAnthropic:
    """client.messages.parse / create / stream 만 흉내 낸다. 호출 kwargs 를 `calls` 에 기록한다."""

    def __init__(self, *, parsed_output=None, stop_reason="end_turn", text="", deltas=None, error=None,
                 stream_error_after=None):
        self.parsed_output = parsed_output
        self.stop_reason = stop_reason
        self.text = text
        self.deltas = deltas or []
        self.error = error
        self.stream_error_after = stream_error_after
        self.calls: list[tuple[str, dict]] = []
        self.messages = self  # client.messages.<method>

    def parse(self, **kwargs):
        self.calls.append(("parse", kwargs))
        if self.error:
            raise self.error
        return SimpleNamespace(parsed_output=self.parsed_output, stop_reason=self.stop_reason,
                               usage=fake_usage(), model=kwargs["model"], content=[])

    def create(self, **kwargs):
        self.calls.append(("create", kwargs))
        if self.error:
            raise self.error
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.text)], stop_reason=self.stop_reason,
                               usage=fake_usage(), model=kwargs["model"])

    @contextmanager
    def stream(self, **kwargs):
        self.calls.append(("stream", kwargs))
        if self.error:
            raise self.error
        fake = self

        class _Stream:
            def __iter__(self):
                for i, d in enumerate(fake.deltas):
                    if fake.stream_error_after is not None and i >= fake.stream_error_after:
                        raise RuntimeError("stream broke")
                    yield SimpleNamespace(type="text", text=d)

            def get_final_message(self):
                return SimpleNamespace(stop_reason=fake.stop_reason, usage=fake_usage(),
                                       content=[SimpleNamespace(type="text", text="".join(fake.deltas))])

        yield _Stream()


def parse_sse(body: str) -> list[dict]:
    events = []
    for line in body.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: "):]))
    return events
