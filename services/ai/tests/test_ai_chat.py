"""/chat SSE 스트리밍, 세션 메모리(TTL·상한), DELETE, 스트림 실패 폴백, 자유입력 마스킹, 판정 아님 표기."""
import pytest
from ai_testing import FakeAnthropic, parse_sse
from dbp_ai import chat, llm
from dbp_ai.schemas import CHAT_NOTICE


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
    done = events[-1]
    assert done == {"done": True, "provider": "anthropic", "sessionId": "s-st", "auditId": r.headers["x-audit-id"],
                    "eligibilitySource": "rule-engine", "notice": CHAT_NOTICE, "masked": False}
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


# ---- 세션 TTL·상한 (F20) ----


def test_session_expires_after_ttl(client, chat_body, monkeypatch):
    now = [5000.0]
    monkeypatch.setattr(chat, "_clock", lambda: now[0])
    client.post("/chat/complete", json=chat_body("안녕하세요", "s-ttl"))
    now[0] += chat.SESSION_TTL_S - 1
    assert chat.session_count() == 1
    now[0] += 2
    assert chat.session_count() == 0


def test_session_ttl_counts_from_last_use(client, chat_body, monkeypatch):
    now = [5000.0]
    monkeypatch.setattr(chat, "_clock", lambda: now[0])
    client.post("/chat/complete", json=chat_body("안녕하세요", "s-live"))
    now[0] += chat.SESSION_TTL_S - 10
    client.post("/chat/complete", json=chat_body("기초연금 알려 주세요", "s-live"))
    now[0] += 20
    assert chat.session_count() == 1
    assert len(chat.get_session("s-live")["messages"]) == 4


def test_session_store_is_capped(monkeypatch):
    monkeypatch.setattr(chat, "MAX_SESSIONS", 3)
    for i in range(5):
        chat.get_session(f"s-{i}")
    assert chat.session_count() == 3
    assert list(chat._SESSIONS) == ["s-2", "s-3", "s-4"]  # 가장 오래 쓰지 않은 세션부터 버린다


# ---- 자유입력 마스킹 (F21) ----


@pytest.mark.parametrize("raw,leak", [
    ("제 주민번호는 580312-1234567 입니다", "580312-1234567"),
    ("주민번호 5803121234567", "5803121234567"),
    ("연락처 010-1234-5678 로 주세요", "010-1234-5678"),
    ("전화 01012345678", "01012345678"),
    ("집 전화 02-123-4567", "02-123-4567"),
    ("계좌 110-123-456789 로 받나요", "110-123-456789"),
    ("월 소득 250만원 인데요", "250만원"),
    ("연봉 3,200만 원", "3,200만 원"),
    ("통장에 1,200,000원 있어요", "1,200,000원"),
    ("재산 1억 2천만원", "2천만원"),
    ("월 소득 250만 정도예요", "250만"),
    ("연봉 3500만이면 되나요", "3500만"),
    ("집이 1억 2천만", "1억"),
    ("잔액 ₩2,500,000", "2,500,000"),
])
def test_mask_pii_patterns(raw, leak):
    text, masked = chat.mask_pii(raw)
    assert masked is True and leak not in text and chat.MASK in text


@pytest.mark.parametrize("raw", ["기초연금 알려 주세요", "65세 이상 2인 가구예요", "2026-09-14 기준인가요", "중위소득 50% 이하", "7인 가구 혜택"])
def test_mask_pii_leaves_ordinary_text(raw):
    assert chat.mask_pii(raw) == (raw, False)


def test_chat_masks_message_before_llm_session_and_audit(client, chat_body, anthropic_env):
    fake = FakeAnthropic(text="말씀하지 않으셔도 됩니다.")
    llm.set_client(fake)
    msg = "주민번호 580312-1234567, 월 250만원 버는데 기초연금 되나요?"
    body = client.post("/chat/complete", json=chat_body(msg, "s-mask")).json()
    assert body["masked"] is True
    assert body["text"].startswith(chat.MASK_NOTICE) and "말씀하지 않으셔도 됩니다" in body["text"]

    sent = fake.calls[0][1]["messages"][-1]["content"]
    stored = chat.get_session("s-mask")["messages"][0]["content"]
    audited = str(client.get(f"/audit/{body['auditId']}").json())
    for where in (sent, stored, audited):
        assert "580312-1234567" not in where and "250만원" not in where
        assert chat.MASK in where and "기초연금" in where


def test_stream_masks_message_and_flags_done_event(client, chat_body):
    r = client.post("/chat", json=chat_body("010-1234-5678 로 기초연금 안내 받을 수 있나요", "s-mask2"))
    events = parse_sse(r.text)
    assert events[-1]["masked"] is True
    assert "".join(e["delta"] for e in events[:-1]).startswith(chat.MASK_NOTICE)
    assert "010-1234-5678" not in str(chat.get_session("s-mask2")["messages"])


# ---- 채팅은 판정이 아님 (F22) ----


def test_chat_response_has_eligibility_source_not_judged_by(client, chat_body):
    body = client.post("/chat/complete", json=chat_body("기초연금 알려 주세요", "s-src")).json()
    assert "judgedBy" not in body
    assert body["eligibilitySource"] == "rule-engine" and body["notice"] == CHAT_NOTICE
    assert body["masked"] is False


def test_llm_answer_affirming_ineligible_policy_is_replaced_by_template(client, chat_body, anthropic_env, persona):
    assert persona["policies"]["nbl-livelihood"] is False
    llm.set_client(FakeAnthropic(text="생계급여도 받으실 수 있습니다. 행정복지센터에 가 보세요."))
    body = client.post("/chat/complete", json=chat_body("생계급여 받을 수 있나요?", "s-contra")).json()
    assert body["provider"] == "template"
    assert "받으실 수 있습니다" not in body["text"]
    assert "규칙 엔진 판정 결과, 현재 기준에는 해당하지 않습니다" in body["text"]
    audit = client.get(f"/audit/{body['auditId']}").json()
    assert audit["provider"] == "template"  # 화면에 나간 답과 감사 기록이 어긋나지 않는다


def test_llm_answer_mentioning_ineligible_policy_negatively_is_kept(client, chat_body, anthropic_env):
    text = "생계급여는 규칙 엔진 판정 결과 현재 기준에는 해당하지 않습니다. 기초연금은 신청하실 수 있습니다."
    llm.set_client(FakeAnthropic(text=text))
    body = client.post("/chat/complete", json=chat_body("생계급여랑 기초연금은요?", "s-neg")).json()
    assert body["provider"] == "anthropic" and body["text"] == text


def test_stream_affirming_ineligible_policy_gets_correction(client, chat_body, anthropic_env):
    llm.set_client(FakeAnthropic(deltas=["에너지바우처도 ", "신청하실 수 있습니다."]))
    r = client.post("/chat", json=chat_body("에너지바우처 되나요?", "s-corr"))
    text = "".join(e["delta"] for e in parse_sse(r.text)[:-1])
    assert "바로잡습니다: 에너지바우처" in text and "현재 기준에는 해당하지 않습니다" in text
