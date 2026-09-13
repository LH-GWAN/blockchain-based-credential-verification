"""발급 → 폐기 흐름 (FakeLedger). 원본 수치가 응답·VC·DB 어디에도 없어야 한다."""
import json
import time

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
    req = ["daeguResident", "incomeBelow50Median", "incomeBelow32Median", "ageOver65"]
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": req, "consent": {"scope": req, "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    issued = {c["claim"] for c in body["credentials"]}
    assert issued == {"daeguResident", "incomeBelow50Median", "ageOver65"}
    assert [d["claim"] for d in body["denied"]] == ["incomeBelow32Median"]
    # VC 에는 사실 하나(불리언)만, 원본 수치 없음
    vc = decode_vc(body["credentials"][0]["vcJwt"])
    subj = vc["credentialSubject"]
    assert set(subj) == {"id", body["credentials"][0]["claim"]}
    text = json.dumps(body, ensure_ascii=False)
    for forbidden in ["1000000", "1958", "monthlyIncomeKRW", "birthDate", "김복례"]:
        assert forbidden not in text, forbidden
    # 동의 영수증이 원장에 앵커됨
    assert body["consentReceipt"]["hash"] in ledger.receipts
    # 폐기 → 상태목록 버전 증가, 원장 갱신
    jti = body["credentials"][0]["jti"]
    rv = client.post(f"/admin/credentials/{jti}/revoke").json()
    assert rv["revoked"] and rv["statusListVersion"] == 2
    assert ledger.status_lists[settings.status_list_id]["version"] == 2
    assert client.app.state.svc.is_revoked_locally(rv["statusListIndex"]) is True


def test_bank_issuer_only_knows_its_fields(tmp_path, monkeypatch):
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-09-14")
    settings = Settings(issuer_id="imbank", db_path=str(tmp_path / "imbank.db"))
    client = TestClient(create_app(settings, ledger=FakeLedger(bundle_hash(load_bundle())), store=Store(settings.db_path)))
    holder = generate_holder_key()
    wk = client.get("/.well-known/issuer").json()
    assert {c["claim"] for c in wk["claims"]} == {"creditBottom20", "annualIncomeUnder35M"}
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["daeguResident"], "consent": {"scope": ["daeguResident"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 400 and "CLAIM_NOT_ISSUED_HERE" in r.text
    r = client.post("/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": _holder_proof(client, holder),
        "requestedClaims": ["creditBottom20"], "consent": {"scope": ["creditBottom20"], "ts": "2026-09-14T09:00:00Z"},
    })
    assert r.status_code == 200 and r.json()["credentials"][0]["claim"] == "creditBottom20"


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
