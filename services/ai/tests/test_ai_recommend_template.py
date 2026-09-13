"""템플릿 provider 로 페르소나(C-001) 추천 — 정확히 3개, 모두 유효 인용, 부적격 정책 0건."""
from ai_testing import INELIGIBLE_FOR_PERSONA
from dbp_ai.retriever import get_store


def test_persona_template_recommend(client, recommend_body, persona):
    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "template"
    assert body["judgedBy"] == "rule-engine"
    assert body["disclaimer"]
    items = body["recommendations"]
    assert len(items) == 3

    store = get_store()
    for it in items:
        assert it["policyId"] in persona["eligibleIds"]
        assert it["policyId"] not in INELIGIBLE_FOR_PERSONA
        assert it["citations"], it
        assert set(it["citations"]) <= store.clause_ids(it["policyId"])
        assert it["source"] == "template"
        assert it["headline"] and it["explanation"] and it["nextSteps"]
        assert store.by_id[it["policyId"]]["legalBasis"][0]["clauseId"] == it["citations"][0]

    # 정렬: 은행 서민금융(finance) 먼저, 제도명 가나다순 → 새희망홀씨, 소액생계비대출, 햇살론뱅크
    assert [it["policyId"] for it in items] == ["new-hope-loan", "micro-livelihood-loan", "sunshine-loan-bank"]


def test_template_ordering_across_channels(client, recommend_body):
    """서민금융 1개 → 민간 감면 → 공공 복지 순으로 이어진다 (교통은 마지막)."""
    keep = {"basic-pension", "micro-livelihood-loan", "daegu-metro-free", "telecom-discount"}
    recommend_body["ruleResults"] = [
        {**rr, "eligible": rr["eligible"] and rr["policyId"] in keep} for rr in recommend_body["ruleResults"]
    ]
    r = client.post("/recommend", json=recommend_body)
    assert [it["policyId"] for it in r.json()["recommendations"]] == [
        "micro-livelihood-loan", "telecom-discount", "basic-pension"]


def test_no_eligible_policies_yields_empty_list(client, recommend_body):
    recommend_body["ruleResults"] = [{**rr, "eligible": False} for rr in recommend_body["ruleResults"]]
    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200
    assert r.json()["recommendations"] == []
    assert r.json()["provider"] == "template"


def test_unknown_policy_ids_are_never_candidates(client, recommend_body):
    recommend_body["ruleResults"].append({"policyId": "daegu-youth-happiness", "eligible": True, "matchedClaims": []})
    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 200
    assert all(it["policyId"] != "daegu-youth-happiness" for it in r.json()["recommendations"])


def test_template_explanation_is_built_from_policy_doc(client, recommend_body):
    r = client.post("/recommend", json=recommend_body)
    store = get_store()
    first = r.json()["recommendations"][0]
    p = store.by_id[first["policyId"]]
    assert p["summary"] in first["explanation"]
    assert p["legalBasis"][0]["title"] in first["explanation"]
    assert p["howToApply"] in first["nextSteps"]
