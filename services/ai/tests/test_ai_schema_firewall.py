"""PII 방화벽 (스키마): categoricalProfile 의 allowlist 밖 필드는 무엇이든 422."""
import pytest


@pytest.mark.parametrize("extra", [
    {"monthlyIncomeKRW": 1000000},
    {"annualIncomeKRW": 12000000},
    {"name": "김복례"},
    {"birthDate": "1958-03-12"},
    {"citizenId": "C-001"},
    {"residenceSigungu": "북구"},
])
def test_extra_profile_field_is_rejected(client, recommend_body, extra):
    recommend_body["categoricalProfile"] = {**recommend_body["categoricalProfile"], **extra}
    r = client.post("/recommend", json=recommend_body)
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("field,value", [
    ("ageBand", "68"), ("householdSize", 0), ("householdSize", 7), ("residence", "seoul"),
    ("incomeBracket", "≤40%"), ("recipientStatus", "maybe"), ("creditTier", "top10"),
])
def test_out_of_range_profile_value_is_rejected(client, recommend_body, field, value):
    recommend_body["categoricalProfile"] = {**recommend_body["categoricalProfile"], field: value}
    assert client.post("/recommend", json=recommend_body).status_code == 422


def test_missing_profile_field_is_rejected(client, recommend_body):
    prof = dict(recommend_body["categoricalProfile"])
    prof.pop("incomeBracket")
    recommend_body["categoricalProfile"] = prof
    assert client.post("/recommend", json=recommend_body).status_code == 422


def test_extra_rule_result_field_is_rejected(client, recommend_body):
    recommend_body["ruleResults"][0] = {**recommend_body["ruleResults"][0], "monthlyIncomeKRW": 1000000}
    assert client.post("/recommend", json=recommend_body).status_code == 422


def test_extra_top_level_field_is_rejected(client, recommend_body):
    recommend_body["citizen"] = {"name": "김복례"}
    assert client.post("/recommend", json=recommend_body).status_code == 422


def test_chat_extra_profile_field_is_rejected(client, chat_body):
    body = chat_body("안녕하세요")
    body["categoricalProfile"] = {**body["categoricalProfile"], "monthlyIncomeKRW": 1000000}
    assert client.post("/chat/complete", json=body).status_code == 422
    assert client.post("/chat", json=body).status_code == 422


def test_unsupported_locale_is_rejected(client, recommend_body):
    recommend_body["locale"] = "en"
    assert client.post("/recommend", json=recommend_body).status_code == 422
