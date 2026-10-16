"""발급 → 폐기 흐름 (FakeLedger). 원본 수치가 응답·VC·DB 어디에도 없어야 한다."""
import json

import pytest
from fastapi.testclient import TestClient

from dbp_rules import bundle_hash, load_bundle
from dbp_vc import decode_vc, generate_holder_key, sign_jws

from dbp_issuer.app import create_app
from dbp_issuer.config import Settings
from dbp_issuer.db import Store
from dbp_issuer.ledger_iface import FakeLedger


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-09-14")
    settings = Settings(issuer_id="daegu", db_path=str(tmp_path / "daegu.db"))
    ledger = FakeLedger(bundle_hash(load_bundle()))
    app = create_app(settings, ledger=ledger, store=Store(settings.db_path))
    return TestClient(app), ledger, settings


def _holder_proof(client, holder):
    ch = client.post("/credentials/challenge", json={"holderDid": holder.did}).json()
    return sign_jws(header={"alg": "EdDSA", "typ": "holder-proof+jwt"},
                    payload={"iss": holder.did, "aud": ch["aud"], "nonce": ch["nonce"]},
                    private_key=holder.private_key)


def test_issue_then_revoke(env):
    client, ledger, settings = env
    holder = generate_holder_key()
    req = ["daeguResident", "hasStudentChild", "ageOver65"]
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": req, "consent": {"scope": req, "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    issued = {c["claim"] for c in body["credentials"]}
    assert issued == {"daeguResident", "ageOver65"}
    assert [d["claim"] for d in body["denied"]] == ["hasStudentChild"]
    # VC 에는 사실 하나(불리언)만, 원본 수치 없음
    vc = decode_vc(body["credentials"][0]["vcJwt"])["vc"]
    subj = vc["credentialSubject"]
    assert set(subj) == {"id", body["credentials"][0]["claim"]}
    text = json.dumps(body, ensure_ascii=False)
    for forbidden in ["1000000", "1958", "monthlyIncomeKRW", "birthDate", "김복례"]:
        assert forbidden not in text, forbidden
    # 동의 영수증이 원장에 앵커됨 (응답 뒤 BackgroundTasks — TestClient 는 응답 반환 전에 끝까지 실행한다)
    assert body["consentReceipt"]["hash"] in ledger.receipts
    assert body["consentReceipt"]["txHash"] is None and body["consentReceipt"]["anchor"] == "pending"
    rc = client.get(f"/consent-receipts/{body['consentReceipt']['hash']}").json()
    assert rc["anchor"] == "anchored" and rc["txHash"].startswith("0x")
    # 폐기 → 상태목록 버전 증가, 원장 갱신
    jti = body["credentials"][0]["jti"]
    rv = client.post(f"/admin/credentials/{jti}/revoke").json()
    assert rv["revoked"] and rv["statusListVersion"] == 2 and rv["txHash"]
    assert ledger.status_lists[settings.status_list_id]["version"] == 2
    assert client.app.state.svc.is_revoked_locally(rv["statusListIndex"]) is True


def test_welfare_issuer_only_knows_its_fields(tmp_path, monkeypatch):
    """복지기관은 소득·수급·재직(건보 자격) 사실만, 대구시는 주민등록·가족관계 사실만 발급한다. 신용평점(self)은 누구도 발급하지 않는다."""
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-09-14")
    settings = Settings(issuer_id="welfare", db_path=str(tmp_path / "welfare.db"))
    client = TestClient(create_app(settings, ledger=FakeLedger(bundle_hash(load_bundle())), store=Store(settings.db_path)))
    holder = generate_holder_key()
    wk = client.get("/.well-known/issuer").json()
    assert {c["claim"] for c in wk["claims"]} == {"isBenefitRecipient", "incomeBelow32Median", "incomeBelow48Median",
                                                 "incomeBelow50Median", "incomeBelowBasicPensionLine",
                                                 "annualIncomeUnder35M", "annualIncomeUnder40M", "annualIncomeUnder45M",
                                                 "annualIncomeUnder50M", "annualIncomeUnder60M", "employed"}
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["daeguResident"], "consent": {"scope": ["daeguResident"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 400 and "CLAIM_NOT_ISSUED_HERE" in r.text
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["creditBottom20"], "consent": {"scope": ["creditBottom20"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 400 and "CLAIM_NOT_ISSUED_HERE" in r.text
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["annualIncomeUnder35M", "annualIncomeUnder40M", "incomeBelow50Median"],
        "consent": {"scope": ["annualIncomeUnder35M", "annualIncomeUnder40M", "incomeBelow50Median"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 200 and {c["claim"] for c in r.json()["credentials"]} == {
        "annualIncomeUnder35M", "annualIncomeUnder40M", "incomeBelow50Median"}


def test_rule_hash_mismatch_blocks_issuance(tmp_path, monkeypatch):
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-09-14")
    settings = Settings(issuer_id="daegu", db_path=str(tmp_path / "d.db"))
    client = TestClient(create_app(settings, ledger=FakeLedger("0x" + "ab" * 32), store=Store(settings.db_path)))
    holder = generate_holder_key()
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["daeguResident"], "consent": {"scope": ["daeguResident"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 503 and "RULE_HASH_MISMATCH" in r.text


def test_holder_proof_required(env):
    client, _, _ = env
    holder = generate_holder_key()
    other = generate_holder_key()
    ch = client.post("/credentials/challenge", json={"holderDid": holder.did}).json()
    bad = sign_jws(header={"alg": "EdDSA", "typ": "holder-proof+jwt"},
                   payload={"iss": holder.did, "aud": ch["aud"], "nonce": ch["nonce"]}, private_key=other.private_key)
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": bad,
        "requestedClaims": ["daeguResident"], "consent": {"scope": ["daeguResident"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 401


def test_daegu_issues_household_head_and_marriage(tmp_path, monkeypatch):
    """대구시는 주민등록(세대주)·가족관계(혼인) 사실을 발급한다. 참인 사실만 증명서가 된다."""
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-09-14")
    settings = Settings(issuer_id="daegu", db_path=str(tmp_path / "daegu.db"))
    client = TestClient(create_app(settings, ledger=FakeLedger(bundle_hash(load_bundle())), store=Store(settings.db_path)))
    wk = {c["claim"] for c in client.get("/.well-known/issuer").json()["claims"]}
    assert {"householdHead", "married"} <= wk and "employed" not in wk
    holder = generate_holder_key()
    # C-008: 2인 가구 세대주, 기혼
    r = client.post("/credentials/issue", json={
        "citizenId": "C-008", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["householdHead", "married"], "consent": {"scope": ["householdHead", "married"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 200, r.text
    assert {c["claim"] for c in r.json()["credentials"]} == {"householdHead", "married"}
