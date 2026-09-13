"""환각 프로브: 존재하지 않는 제도 → "등록되어 있지 않" + 자격 판정 없음."""
from conftest import PROBE_MESSAGE, VERDICT_MARKERS, FakeAnthropic

from dbp_ai import llm
from dbp_ai.prompts import SYSTEM_RULES, system_prompt_text
from dbp_ai.retriever import get_store

REQUIRED_RULE_SENTENCES = [
    "당신은 자격을 판정하지 않는다",
    "규칙 엔진이 이미 결정했고",
    "등록되어 있지 않습니다",
    "요구하거나 추정하지 않는다",
    "쉬운 한국어, 존댓말, 짧은 문장",
]


def test_probe_under_template_provider(client, chat_body):
    r = client.post("/chat/complete", json=chat_body(PROBE_MESSAGE))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "template"
    assert body["judgedBy"] == "rule-engine"
    assert "등록되어 있지 않" in body["text"]
    for marker in VERDICT_MARKERS:
        assert marker not in body["text"], marker


def test_probe_under_anthropic_provider_with_fake_client(client, chat_body, anthropic_env, persona):
    fake = FakeAnthropic(text="말씀하신 제도는 정책 DB에 등록되어 있지 않습니다. 등록된 제도만 안내해 드립니다.")
    llm.set_client(fake)
    r = client.post("/chat/complete", json=chat_body(PROBE_MESSAGE))
    assert r.status_code == 200
    assert r.json()["provider"] == "anthropic"
    assert "등록되어 있지 않" in r.json()["text"]

    method, kw = fake.calls[0]
    assert method == "create"
    system_text = kw["system"][0]["text"]
    for sentence in REQUIRED_RULE_SENTENCES:
        assert sentence in system_text, sentence
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    # 채팅에는 범주 프로필과 판정 결과가 (캐시 프리픽스 뒤) 두 번째 system 블록으로 들어간다
    context = kw["system"][1]["text"]
    for k, v in persona["categoricalProfile"].items():
        assert f"{k}={v}" in context
    for rr in persona["ruleResults"]:
        assert rr["policyId"] in context
    assert kw["messages"][-1] == {"role": "user", "content": PROBE_MESSAGE}
    assert kw["thinking"] == {"type": "adaptive"}


def test_system_prompt_contains_full_policy_corpus():
    text = system_prompt_text()
    assert text.startswith(SYSTEM_RULES)
    store = get_store()
    for p in store.policies:
        assert p["policyId"] in text and p["name"] in text
        assert p["summary"] in text and p["howToApply"] in text
        for c in p["legalBasis"]:
            assert c["clauseId"] in text and c["title"] in text and c["text"] in text
            assert c["sourceUrl"] not in text  # URL 은 프롬프트에 넣지 않는다
        if p.get("notes"):
            assert p["notes"] in text


def test_template_chat_answers_registered_policy_with_rule_result_only(client, chat_body):
    r = client.post("/chat/complete", json=chat_body("생계급여 받을 수 있나요?"))
    text = r.json()["text"]
    assert "생계급여" in text
    assert "규칙 엔진 판정 결과, 현재 기준에는 해당하지 않습니다" in text
    assert "nbl-livelihood-c1" in text
