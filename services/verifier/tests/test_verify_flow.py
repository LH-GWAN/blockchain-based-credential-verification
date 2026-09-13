"""검증 절차 테스트: 정상 PASS, 폐기·재사용·만료·위조·타인 증명서·비활성 발급기관·미등록 발급기관 차단."""
import time

import pytest
from fastapi.testclient import TestClient

from dbp_rules import bundle_hash, load_bundle
from dbp_vc import (create_status_list, create_vp, encode_status_list, generate_holder_key, issue_vc, set_status)

from dbp_verifier.app import create_app

BUNDLE = load_bundle()
BHASH = bundle_hash(BUNDLE)
ISSUER = generate_holder_key(bytes([1]) * 32)
ISSUER_DID = "did:dbp:daegu"


class FakeLedger:
    def __init__(self):
        self.issuers = {ISSUER_DID: {"did": ISSUER_DID, "ed25519PubKey": ISSUER.public_key, "name": "대구광역시",
                                     "controller": "0x0", "active": True, "registeredAt": 0}}
        self.bits = create_status_list(131072)
        self.lists = {"dbp:status:daegu:list-1": {"encodedList": encode_status_list(self.bits), "version": 1, "updatedAt": 0, "owner": "0x0"}}
        self.receipts = {}

    def is_connected(self):
        return True

    def get_issuer(self, did):
        if did not in self.issuers:
            raise KeyError(did)
        return self.issuers[did]

    def get_bundle(self, bundle, version):
        return {"bundleHash": BHASH, "schemaHash": "0x00", "by": "0x0", "at": 0}

    def get_status_list(self, list_id):
        return self.lists[list_id]

    def revoke(self, index):
        set_status(self.bits, index, True)
        self.lists["dbp:status:daegu:list-1"] = {"encodedList": encode_status_list(self.bits), "version": 2, "updatedAt": 0, "owner": "0x0"}

    def anchor_receipt(self, h, kind):
        self.receipts[h] = kind
        return "0xfaketx"


def _vc(holder_did, claim, index, issuer_key=ISSUER, valid_until="2027-09-14T00:00:00Z", valid_from="2026-09-01T00:00:00Z", bhash=BHASH):
    return issue_vc(id=f"urn:uuid:{claim}-{index}", issuer_did=ISSUER_DID, issuer_kid=ISSUER_DID + "#key-1",
                    issuer_private_key=issuer_key.private_key, holder_did=holder_did, claim={"name": claim, "value": True},
                    valid_from=valid_from, valid_until=valid_until, status={"listId": "dbp:status:daegu:list-1", "index": index},
                    evidence={"bundle": "daegu-eligibility", "version": "2026.1", "bundleHash": bhash})


@pytest.fixture()
def env():
    ledger = FakeLedger()
    client = TestClient(create_app(ledger=ledger))
    holder = generate_holder_key(bytes([2]) * 32)
    vcs = [_vc(holder.did, "daeguResident", 10), _vc(holder.did, "incomeBelow50Median", 11)]
    return client, ledger, holder, vcs


def _present(client, holder, vcs, **kw):
    req = client.post("/requests", json=kw or {}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                   nonce=req["nonce"], vc_jwts=vcs)
    r = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp})
    return req, vp, r.json()


def test_pass_and_timing(env):
    client, ledger, holder, vcs = env
    req, vp, res = _present(client, holder, vcs)
    assert res["verdict"] == "PASS", res
    assert res["claims"] == {"daeguResident": True, "incomeBelow50Median": True}
    assert res["issuers"]["daeguResident"] == "대구광역시"
    assert res["timingsMs"]["total"] < 2000
    assert all(res["checks"].values())
    # 제출 영수증 앵커 (TestClient 는 background task 를 동기 실행)
    done = client.get(f"/results/{req['requestId']}").json()
    assert done["receipt"]["txHash"] == "0xfaketx" and done["receipt"]["hash"] in ledger.receipts
    # 응답에 원본 수치·이름 없음
    import json
    assert "monthlyIncomeKRW" not in json.dumps(res) and "김복례" not in json.dumps(res, ensure_ascii=False)


def test_replay_blocked(env):
    client, ledger, holder, vcs = env
    req, vp, res = _present(client, holder, vcs)
    assert res["verdict"] == "PASS"
    again = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert again["verdict"] == "FAIL" and "NONCE_REUSED" in again["reasonCodes"]
    atk = client.post("/demo/attack", json={"kind": "replay"}).json()
    assert "NONCE_REUSED" in atk["reasonCodes"]
    # 공격 시연은 원래 요청의 PASS 결과를 덮어쓰지 않는다
    orig = client.get(f"/results/{req['requestId']}").json()
    assert orig["verdict"] == "PASS"


def test_revoked_blocked(env):
    client, ledger, holder, vcs = env
    ledger.revoke(11)
    _, _, res = _present(client, holder, vcs)
    assert res["verdict"] == "FAIL" and res["reasonCodes"] == ["REVOKED"]
    assert res["checks"]["notRevoked"] is False and res["checks"]["vcSignature"] is True


def test_forged_and_wrong_holder(env):
    client, ledger, holder, vcs = env
    _present(client, holder, vcs)
    forged = client.post("/demo/attack", json={"kind": "forged"}).json()
    assert "VC_SIG_INVALID" in forged["reasonCodes"] and "HOLDER_MISMATCH" in forged["reasonCodes"]
    wrong = client.post("/demo/attack", json={"kind": "wrong-holder"}).json()
    assert wrong["reasonCodes"] == ["HOLDER_MISMATCH", "CLAIM_MISSING"] or "HOLDER_MISMATCH" in wrong["reasonCodes"]
    expired = client.post("/demo/attack", json={"kind": "expired"}).json()
    assert "NONCE_EXPIRED" in expired["reasonCodes"]


def test_expired_credential_and_unknown_issuer(env):
    client, ledger, holder, vcs = env
    old = _vc(holder.did, "daeguResident", 12, valid_from="2025-01-01T00:00:00Z", valid_until="2026-01-01T00:00:00Z")
    _, _, res = _present(client, holder, [old, vcs[1]])
    assert "EXPIRED" in res["reasonCodes"]
    ledger.issuers[ISSUER_DID]["active"] = False
    _, _, res = _present(client, holder, vcs)
    assert "ISSUER_INACTIVE" in res["reasonCodes"]
    del ledger.issuers[ISSUER_DID]
    _, _, res = _present(client, holder, vcs)
    assert "ISSUER_UNKNOWN" in res["reasonCodes"] and res["verdict"] == "FAIL"


def test_rule_hash_mismatch_and_claim_false(env):
    client, ledger, holder, vcs = env
    bad = _vc(holder.did, "daeguResident", 13, bhash="0x" + "ab" * 32)
    _, _, res = _present(client, holder, [bad, vcs[1]])
    assert "RULE_HASH_MISMATCH" in res["reasonCodes"]
    _, _, res = _present(client, holder, [vcs[0]])
    assert res["reasonCodes"] == ["CLAIM_MISSING"]


def test_aud_mismatch(env):
    client, ledger, holder, vcs = env
    req = client.post("/requests", json={}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did="did:dbp:someone-else",
                   nonce=req["nonce"], vc_jwts=vcs)
    res = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert "AUD_MISMATCH" in res["reasonCodes"]
