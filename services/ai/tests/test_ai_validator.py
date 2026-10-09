"""인용 검증기 + 가짜 Anthropic 클라이언트: 환각 항목은 걸러지고 템플릿으로 채워진다."""
import json

from ai_testing import FakeAnthropic
from dbp_ai import llm
from dbp_ai.retriever import get_store
from dbp_ai.schemas import LLMRecommendation, RecommendationResponse
from dbp_ai.validator import number_tokens, validate_llm_recommendations

VALID_ITEM = LLMRecommendation(
    policyId="nbl-housing", headline="주거급여를 신청하실 수 있습니다",
    explanation="규칙 엔진 판정 결과, 주거급여 신청 기준을 충족합니다. 임차료를 지원받습니다.",
    citations=["nbl-housing-c2"], nextSteps="주소지 행정복지센터에 방문해 신청하세요.",
)


def _mixed_llm_output() -> RecommendationResponse:
    return RecommendationResponse(recommendations=[
        LLMRecommendation(policyId="basic-pension", headline="기초연금", explanation="매월 지급됩니다.",
                          citations=["basic-pension-c9"], nextSteps="국민연금공단 방문"),  # 없는 clauseId
        LLMRecommendation(policyId="daegu-youth-happiness", headline="대구 청년 행복수당", explanation="청년에게 지급",
                          citations=["basic-pension-c1"], nextSteps="구청 방문"),  # 없는 policyId
        VALID_ITEM,
    ])


def test_fake_llm_only_valid_item_survives_and_list_is_topped_up(client, recommend_body, anthropic_env):
    fake = FakeAnthropic(parsed_output=_mixed_llm_output())
    llm.set_client(fake)

    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "anthropic"
    items = body["recommendations"]
    assert len(items) == 3
    llm_items = [it for it in items if it["source"] == "llm"]
    assert [it["policyId"] for it in llm_items] == ["nbl-housing"]
    assert llm_items[0]["citations"] == ["nbl-housing-c2"]
    assert {it["policyId"] for it in items if it["source"] == "template"} == {"new-hope-loan", "micro-livelihood-loan"}
    assert all(it["policyId"] != "daegu-youth-happiness" for it in items)


def test_sdk_call_shape(client, recommend_body, anthropic_env):
    fake = FakeAnthropic(parsed_output=_mixed_llm_output())
    llm.set_client(fake)
    client.post("/recommend", json=recommend_body)

    assert len(fake.calls) == 1
    method, kw = fake.calls[0]
    assert method == "parse"
    assert kw["model"] == "claude-opus-5"
    assert kw["max_tokens"] == 4096
    assert kw["output_format"] is RecommendationResponse
    assert kw["thinking"] == {"type": "adaptive"}
    assert kw["output_config"] == {"effort": "medium"}
    assert kw["system"][0]["type"] == "text"
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kw["messages"][0]["role"] == "user"


def test_llm_never_sees_ineligible_policies_as_candidates(client, recommend_body, anthropic_env, persona):
    fake = FakeAnthropic(parsed_output=RecommendationResponse(recommendations=[VALID_ITEM]))
    llm.set_client(fake)
    client.post("/recommend", json=recommend_body)
    user_msg = fake.calls[0][1]["messages"][0]["content"]
    candidates, _, rest = user_msg.partition("- 부적격 판정")
    for pid in ("nbl-livelihood", "nbl-education", "energy-voucher"):
        assert pid not in candidates
        assert pid in rest  # 질문 대응용으로 "추천 금지" 목록에는 보인다
    for pid in persona["eligibleIds"]:
        assert pid in candidates


def test_refusal_falls_back_to_template(client, recommend_body, anthropic_env):
    llm.set_client(FakeAnthropic(parsed_output=None, stop_reason="refusal"))
    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200
    assert r.json()["provider"] == "template"
    assert len(r.json()["recommendations"]) == 3
    assert all(it["source"] == "template" for it in r.json()["recommendations"])


def test_sdk_error_falls_back_to_template(client, recommend_body, anthropic_env):
    llm.set_client(FakeAnthropic(error=RuntimeError("boom")))
    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200
    assert r.json()["provider"] == "template"
    assert len(r.json()["recommendations"]) == 3


def test_missing_api_key_uses_template(client, recommend_body, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.post("/recommend", json=recommend_body)
    assert r.json()["provider"] == "template"


# ---- 검증기 단위 테스트 ----


def _run(items, eligible=("nbl-housing", "basic-pension", "near-poor")):
    return validate_llm_recommendations(items, set(eligible), get_store())


def test_validator_drops_ineligible_policy():
    item = VALID_ITEM.model_copy(update={"policyId": "nbl-livelihood", "citations": ["nbl-livelihood-c1"]})
    survivors, dropped = _run([item])
    assert survivors == [] and dropped[0]["reason"] == "not-an-eligible-candidate"


def test_validator_drops_empty_citations():
    survivors, dropped = _run([VALID_ITEM.model_copy(update={"citations": []})])
    assert survivors == [] and dropped[0]["reason"] == "no-citation"


def test_validator_drops_clause_from_other_policy():
    survivors, dropped = _run([VALID_ITEM.model_copy(update={"citations": ["nbl-housing-c1", "basic-pension-c1"]})])
    assert survivors == [] and dropped[0]["reason"] == "unknown-clause"


def test_validator_drops_unregistered_program_name_in_text():
    item = VALID_ITEM.model_copy(update={"explanation": "주거급여와 함께 대구 청년 행복수당도 신청하세요."})
    survivors, dropped = _run([item])
    assert survivors == [] and dropped[0]["reason"] == "unknown-program-name"
    assert "행복수당" in dropped[0]["terms"]


def test_validator_allows_mentions_of_other_eligible_policies():
    item = VALID_ITEM.model_copy(update={
        "explanation": "주거급여 수급자가 되면 에너지바우처도 신청할 수 있습니다. 생계·의료·주거·교육급여 수급자에게 적용됩니다."})
    survivors, dropped = _run([item], eligible=("nbl-housing", "energy-voucher", "nbl-education"))
    assert len(survivors) == 1 and survivors[0].source == "llm" and dropped == []


def test_validator_drops_mention_of_ineligible_policy():
    """F23: 적격 카드 본문에 부적격 제도를 끼워 넣으면 ("기초연금도 받으실 수 있습니다") 그 항목을 버린다."""
    item = VALID_ITEM.model_copy(update={"explanation": "규칙 엔진 판정 결과 주거급여 기준을 충족합니다. 에너지바우처도 받으실 수 있습니다."})
    survivors, dropped = _run([item])  # energy-voucher 는 적격 후보가 아니다
    assert survivors == [] and dropped[0]["reason"] == "mentions-ineligible-policy"
    assert dropped[0]["policyIds"] == ["energy-voucher"]


def test_validator_drops_number_not_in_policy_document():
    """F23: 정책 문서에 없는 금액·숫자(환각)는 노출하지 않는다."""
    item = VALID_ITEM.model_copy(update={"explanation": "규칙 엔진 판정 결과 주거급여 기준을 충족합니다. 매달 57만원이 지급됩니다."})
    survivors, dropped = _run([item])
    assert survivors == [] and dropped[0]["reason"] == "unknown-number" and "57" in dropped[0]["numbers"]


def test_validator_allows_numbers_from_policy_document():
    doc_numbers = sorted(number_tokens(json.dumps(get_store().by_id["nbl-housing"], ensure_ascii=False)) - {""})
    assert doc_numbers  # 정책 문서에 숫자가 하나는 있어야 이 테스트가 의미 있다
    n = doc_numbers[0]
    item = VALID_ITEM.model_copy(update={"explanation": f"규칙 엔진 판정 결과 주거급여 기준을 충족합니다. 기준값은 {n}입니다."})
    survivors, dropped = _run([item])
    assert len(survivors) == 1 and dropped == []


def test_validator_ignores_digits_inside_clause_ids():
    item = VALID_ITEM.model_copy(update={"explanation": "규칙 엔진 판정 결과 주거급여 기준을 충족합니다(근거 nbl-housing-c2)."})
    survivors, _ = _run([item])
    assert len(survivors) == 1


def test_known_term_matching_is_exact():
    """F23: 부분문자열 매칭이면 '청년기초연금' 이 '기초연금' 으로 통과한다."""
    store = get_store()
    assert store.is_known_term("기초연금") and store.is_known_term("기초 연금")
    assert not store.is_known_term("청년기초연금")
    assert not store.is_known_term("연금")
    assert "청년기초연금" in store.unknown_program_terms("청년기초연금도 신청하세요")
    assert "청년도약계좌" in store.unknown_program_terms("청년도약계좌도 만들어 보세요")


def test_validator_drops_partial_match_program_name():
    item = VALID_ITEM.model_copy(update={"explanation": "규칙 엔진 판정 결과 주거급여 기준을 충족합니다. 청년기초연금도 알아보세요."})
    survivors, dropped = _run([item])
    assert survivors == [] and dropped[0]["reason"] == "unknown-program-name"


def test_validator_dedupes_same_policy():
    survivors, dropped = _run([VALID_ITEM, VALID_ITEM])
    assert len(survivors) == 1 and dropped[0]["reason"] == "duplicate"
