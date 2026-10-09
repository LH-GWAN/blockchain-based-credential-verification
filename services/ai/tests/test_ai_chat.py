"""/chat SSE 스트리밍, 세션 메모리, DELETE, 스트림 실패 폴백."""
from ai_testing import FakeAnthropic, parse_sse
from dbp_ai import chat, llm


def test_sse_stream_template_matches_complete(client, chat_body):
    question = "기초연금은 어떻게 신청하나요?"
    full = client.post("/chat/complete", json=chat_body(question, "s-a")).json()["text"]

    r = client.post("/chat", json=chat_body(question, "s-b"))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(r.text)
    assert events[-1]["done"] is True and events[-1]["provider"] == "template"
    deltas = [e["delta"] for e in events[:-1]]
    assert deltas and "".join(deltas) == full


def test_session_memory_and_delete(client, chat_body):
    client.post("/chat/complete", json=chat_body("안녕하세요", "s-mem"))
    client.post("/chat", json=chat_body("기초연금 알려 주세요", "s-mem"))
    assert len(chat.get_session("s-mem")["messages"]) == 4
    assert chat.get_session("s-mem")["messages"][0] == {"role": "user", "content": "안녕하세요"}

    r = client.delete("/chat/s-mem")
    assert r.status_code == 200 and r.json() == {"sessionId": "s-mem", "discarded": True}
    assert chat.session_count() == 0
    assert client.delete("/chat/s-mem").json()["discarded"] is False


def test_history_is_sent_to_llm(client, chat_body, anthropic_env):
    fake = FakeAnthropic(text="네, 안내해 드리겠습니다.")
    llm.set_client(fake)
    client.post("/chat/complete", json=chat_body("첫 질문", "s-h"))
    client.post("/chat/complete", json=chat_body("둘째 질문", "s-h"))
    _, kw = fake.calls[1]
    assert [m["role"] for m in kw["messages"]] == ["user", "assistant", "user"]
    assert kw["messages"][1]["content"] == "네, 안내해 드리겠습니다."
    assert kw["max_tokens"] == 4096 and kw["output_config"] == {"effort": "medium"}


def test_sse_stream_anthropic_fake(client, chat_body, anthropic_env):
    llm.set_client(FakeAnthropic(deltas=["기초연금은 ", "국민연금공단에서 ", "신청합니다."]))
    r = client.post("/chat", json=chat_body("기초연금 신청", "s-st"))
    events = parse_sse(r.text)
    assert [e["delta"] for e in events[:-1]] == ["기초연금은 ", "국민연금공단에서 ", "신청합니다."]
    assert events[-1] == {"done": True, "provider": "anthropic", "sessionId": "s-st"}
    assert chat.get_session("s-st")["messages"][-1]["content"] == "기초연금은 국민연금공단에서 신청합니다."


def test_stream_failure_before_first_delta_falls_back_to_template(client, chat_body, anthropic_env):
    llm.set_client(FakeAnthropic(error=RuntimeError("down")))
    r = client.post("/chat", json=chat_body("기초연금 신청", "s-fb"))
    events = parse_sse(r.text)
    assert events[-1]["done"] is True and events[-1]["provider"] == "template"
    assert "기초연금" in "".join(e["delta"] for e in events[:-1])


def test_stream_failure_midway_appends_notice(client, chat_body, anthropic_env):
    llm.set_client(FakeAnthropic(deltas=["첫 ", "둘째 ", "셋째"], stream_error_after=2))
    r = client.post("/chat", json=chat_body("기초연금 신청", "s-mid"))
    events = parse_sse(r.text)
    text = "".join(e["delta"] for e in events[:-1])
    assert text.startswith("첫 둘째 ") and chat.STREAM_CUT_NOTICE in text
    assert events[-1]["provider"] == "anthropic"


def test_refusal_in_chat_falls_back_to_template(client, chat_body, anthropic_env):
    llm.set_client(FakeAnthropic(text="", stop_reason="refusal"))
    r = client.post("/chat/complete", json=chat_body("기초연금 알려 주세요", "s-ref"))
    assert r.json()["provider"] == "template" and "기초연금" in r.json()["text"]


def test_old_sunshine_loan_names_map_to_general_guarantee(client, chat_body):
    # 2026.1.2 개편: 햇살론뱅크·근로자햇살론 → 햇살론 일반보증. 옛 이름으로 물어도 후속 상품을 근거와 함께 안내한다.
    for i, question in enumerate(["햇살론뱅크 받으려면 창구에 뭘 내야 하나요?", "근로자 햇살론 신청 방법 알려 주세요"]):
        text = client.post("/chat/complete", json=chat_body(question, f"s-sun-{i}")).json()["text"]
        assert text.startswith("햇살론 일반보증:")
        assert "sunshine-general-c1" in text
        assert "정책 DB에 등록되지" not in text
