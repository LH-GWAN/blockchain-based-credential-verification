"""PII 차단 (후킹): llm_call 경계를 가짜로 바꿔 실제 LLM 에 갈 페이로드에 원본 필드·금액·이름·주민번호가 없음을 확인."""
import json
import re

from ai_testing import PROBE_MESSAGE
from dbp_ai import llm
from dbp_ai.schemas import LLMRecommendation, RecommendationResponse

ALLOWLIST = {"ageBand", "householdSize", "residence", "incomeBracket", "recipientStatus", "creditTier"}
FORBIDDEN_KEYS = ["monthlyIncomeKRW", "annualIncomeKRW", "birthDate", '"name"', "citizenId", "isBasicLivelihoodRecipient"]
RRN_RE = re.compile(r"\d{6}-?\d{7}")
LONG_NUMBER_RE = re.compile(r"\d{7,}")


def _install_fake_llm_call(monkeypatch, result):
    captured = {}

    def fake_llm_call(kind, payload, audit_id=None):
        captured["kind"] = kind
        captured["payload"] = payload
        json.dumps(payload)  # JSON 직렬화 가능해야 한다 (감사 엔드포인트가 그대로 돌려준다)
        return result

    monkeypatch.setattr(llm, "llm_call", fake_llm_call)
    return captured


def _assert_no_pii(payload: dict, citizen: dict):
    js = json.dumps(payload, ensure_ascii=False)
    for key in FORBIDDEN_KEYS:
        assert key not in js, key
    assert citizen["name"] not in js
    assert citizen["birthDate"] not in js
    assert str(citizen["monthlyIncomeKRW"]) not in js
    assert str(citizen["annualIncomeKRW"]) not in js
    assert not RRN_RE.search(js)
    assert not LONG_NUMBER_RE.search(js), LONG_NUMBER_RE.findall(js)
    # 범주 프로필 줄에 등장하는 key=value 는 allowlist 뿐이다
    for block in [*(b["text"] for b in payload["system"]), *(m["content"] for m in payload["messages"])]:
        for line in block.splitlines():
            if "범주 프로필" in line:
                keys = set(re.findall(r"([A-Za-z]+)=", line))
                assert keys <= ALLOWLIST, keys - ALLOWLIST


def test_recommend_payload_contains_only_categorical_values(client, recommend_body, anthropic_env, persona, monkeypatch):
    result = RecommendationResponse(recommendations=[LLMRecommendation(
        policyId="basic-pension", headline="기초연금", explanation="규칙 엔진 판정 결과 신청 기준을 충족합니다.",
        citations=["basic-pension-c1"], nextSteps="국민연금공단 방문")])
    captured = _install_fake_llm_call(monkeypatch, result)

    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200 and r.json()["provider"] == "anthropic"
    assert captured["kind"] == "recommend"
    _assert_no_pii(captured["payload"], persona["citizen"])
    for k, v in persona["categoricalProfile"].items():
        assert f"{k}={v}" in captured["payload"]["messages"][0]["content"]


def test_chat_payload_contains_only_categorical_values(client, chat_body, anthropic_env, persona, monkeypatch):
    captured = _install_fake_llm_call(monkeypatch, "등록되어 있지 않습니다.")
    r = client.post("/chat/complete", json=chat_body(PROBE_MESSAGE))
    assert r.status_code == 200 and r.json()["provider"] == "anthropic"
    assert captured["kind"] == "chat"
    _assert_no_pii(captured["payload"], persona["citizen"])


def test_policy_corpus_itself_has_no_long_numbers():
    """정책 문서(프롬프트 코퍼스)에도 7자리 이상 숫자·주민번호 패턴이 없어야 PII 정규식 검사가 의미 있다."""
    from dbp_ai.prompts import system_prompt_text
    text = system_prompt_text()
    assert not LONG_NUMBER_RE.search(text), LONG_NUMBER_RE.findall(text)
    assert not RRN_RE.search(text)


def test_chat_free_text_pii_is_masked_before_llm(client, chat_body, anthropic_env, persona, monkeypatch):
    """F21: 질문에 주민번호·전화번호·계좌·금액을 적어도 LLM 페이로드에는 가려져서 간다."""
    captured = _install_fake_llm_call(monkeypatch, "말씀하지 않으셔도 됩니다.")
    msg = (f"{persona['citizen']['monthlyIncomeKRW']:,}원 벌어요. 주민번호 580312-1234567, "
           "전화 010-9876-5432, 계좌 3333-01-2345678 입니다. 기초연금 되나요?")
    r = client.post("/chat/complete", json=chat_body(msg))
    assert r.status_code == 200 and r.json()["masked"] is True
    _assert_no_pii(captured["payload"], persona["citizen"])
    js = json.dumps(captured["payload"], ensure_ascii=False)
    for leak in ("580312", "010-9876-5432", "3333-01-2345678", f"{persona['citizen']['monthlyIncomeKRW']:,}"):
        assert leak not in js, leak
