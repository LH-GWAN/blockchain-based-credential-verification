"""검증 절차 테스트: 정상 PASS, 폐기·재사용·만료·위조·타인 증명서·비활성 발급기관·미등록 발급기관 차단."""
import json

import pytest
from dbp_rules import bundle_hash, load_bundle
from dbp_vc import (
    create_status_list,
    create_vp,
    encode_status_list,
    generate_holder_key,
    issue_vc,
    set_status,
)
from dbp_verifier.app import create_app
from fastapi.testclient import TestClient

BUNDLE = load_bundle()
BHASH = bundle_hash(BUNDLE)
ISSUER = generate_holder_key(bytes([1]) * 32)
ISSUER_DID = "did:dbp:daegu"
VERIFIER_DIDS = {"imbank-branch-01": "did:dbp:verifier-imbank-branch-01", "im-savings-01": "did:dbp:verifier-im-savings-01"}


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
                    evidence={"bundle": "daegu-eligibility", "version": "2026.2", "bundleHash": bhash})


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
    req, _vp, res = _present(client, holder, vcs)
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
    client, _ledger, holder, vcs = env
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
    client, _ledger, holder, vcs = env
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
    client, _ledger, holder, vcs = env
    bad = _vc(holder.did, "daeguResident", 13, bhash="0x" + "ab" * 32)
    _, _, res = _present(client, holder, [bad, vcs[1]])
    assert "RULE_HASH_MISMATCH" in res["reasonCodes"]
    _, _, res = _present(client, holder, [vcs[0]])
    assert res["reasonCodes"] == ["CLAIM_MISSING"]


def test_aud_mismatch(env):
    client, _ledger, holder, vcs = env
    req = client.post("/requests", json={}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did="did:dbp:someone-else",
                   nonce=req["nonce"], vc_jwts=vcs)
    res = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert "AUD_MISMATCH" in res["reasonCodes"]


def test_comparison_block_from_single_source(env):
    """결과의 비교 블록은 data/legacy-documents.json 계산값이며 하드코딩이 아니다. 햇살론 일반보증: 소득금액증명 10항목 → 참 1개."""
    client, _, holder, _ = env
    inc = _vc(holder.did, "annualIncomeUnder35M", 21)
    req = client.post("/requests", json={"presetId": "sunshine-general", "purpose": "햇살론 일반보증 대상 확인",
                                         "requested": [{"claim": "annualIncomeUnder35M", "expected": True}]}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                   nonce=req["nonce"], vc_jwts=[inc])
    res = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert res["verdict"] == "PASS"
    c = res["comparison"]
    assert c["presetId"] == "sunshine-general" and [d["name"] for d in c["pullDocuments"]] == ["소득금액증명"]
    assert c["pullCount"] == 10 and c["holdCount"] == 1 and c["reductionPercent"] == 90
    assert c["holdItems"] == ["연소득 3,500만 원 이하 여부 = 참"] and "3년" in c["pullRecords"]
    assert "실제 API 호출 결과가 아니다" in c["honestyNote"]
    presets = client.get("/comparison").json()["presets"]
    assert "sunshine-bank" not in presets
    pre = presets["sunshine-general"]
    assert pre["pullCount"] == c["pullCount"] and pre["holdCount"] == c["holdCount"]
    for banned in ["유출이 불가", "유출 불가", "개인정보가 사라"]:
        assert banned not in json.dumps(c, ensure_ascii=False)


def test_preset_offered_only_at_matching_verifier_kind(env):
    """새희망홀씨는 은행권 상품이라 저축은행 창구에서는 요청 자체가 거부된다.
    햇살론 일반보증은 2026 개편으로 저축은행도 취급하므로, 은행에서 쓴 같은 VC 를 재발급 없이 다시 낸다."""
    client, _, holder, _ = env
    presets = {p["id"]: p for p in client.get("/presets").json()}
    assert presets["new-hope"]["verifierKinds"] == ["bank"]
    assert presets["sunshine-general"]["verifierKinds"] == ["bank", "savings"]
    assert {v["id"]: v["kind"] for v in client.get("/verifiers").json()} == {"imbank-branch-01": "bank", "im-savings-01": "savings"}

    r = client.post("/requests", json={"verifierId": "im-savings-01", "presetId": "new-hope", "purpose": "새희망홀씨 대상 확인",
                                       "requested": [{"claim": "annualIncomeUnder40M", "expected": True}]})
    assert r.status_code == 400 and r.json()["detail"] == "PRESET_NOT_OFFERED"
    # presetId 없이 policyId 만 보내도 우회되지 않는다
    r = client.post("/requests", json={"verifierId": "im-savings-01", "policyId": "new-hope-loan",
                                       "requested": [{"claim": "annualIncomeUnder40M", "expected": True}]})
    assert r.status_code == 400 and r.json()["detail"] == "PRESET_NOT_OFFERED"
    # 같은 상품이라도 은행 창구에서는 요청이 만들어진다
    ok = client.post("/requests", json={"verifierId": "imbank-branch-01", "presetId": "new-hope",
                                        "requested": [{"claim": "annualIncomeUnder40M", "expected": True}]})
    assert ok.status_code == 200 and ok.json()["verifier"] == "did:dbp:verifier-imbank-branch-01"

    inc = _vc(holder.did, "annualIncomeUnder35M", 22)  # 한 번 발급받은 VC
    for verifier_id in ["imbank-branch-01", "im-savings-01"]:
        r = client.post("/requests", json={"verifierId": verifier_id, "presetId": "sunshine-general",
                                           "purpose": "햇살론 일반보증 대상 확인",
                                           "requested": [{"claim": "annualIncomeUnder35M", "expected": True}]})
        assert r.status_code == 200, r.text
        req = r.json()
        assert req["verifier"] == VERIFIER_DIDS[verifier_id]
        vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                       nonce=req["nonce"], vc_jwts=[inc])
        res = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
        assert res["verdict"] == "PASS", res
        assert res["claims"] == {"annualIncomeUnder35M": True}
        assert res["comparison"]["presetId"] == "sunshine-general"


def _present_preset(client, holder, vcs, preset_id, verifier_id="imbank-branch-01"):
    """프리셋 정의(config.PRESETS) 그대로 요청을 만들고 제출한다."""
    p = next(x for x in client.get("/presets").json() if x["id"] == preset_id)
    r = client.post("/requests", json={"verifierId": verifier_id, "presetId": p["id"], "purpose": p["purpose"],
                                       "policyId": p["policyId"], "requested": p["requested"]})
    assert r.status_code == 200, r.text
    req = r.json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                   nonce=req["nonce"], vc_jwts=vcs)
    return client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()


def test_presets_list_in_counter_order(env):
    client, _, _, _ = env
    presets = client.get("/presets").json()
    assert [p["id"] for p in presets] == ["consult", "sunshine-general", "sunshine-general-low-credit",
                                          "new-hope", "new-hope-low-credit", "discount"]
    by_id = {p["id"]: p for p in presets}
    assert by_id["sunshine-general-low-credit"]["label"] == "햇살론 일반보증 · 신용 하위 20% 고객"
    assert by_id["new-hope-low-credit"]["label"] == "새희망홀씨 · 신용 하위 20% 고객"
    assert by_id["sunshine-general-low-credit"]["verifierKinds"] == ["bank", "savings"]
    assert by_id["new-hope-low-credit"]["verifierKinds"] == ["bank"]
    for pid in ["sunshine-general-low-credit", "new-hope-low-credit"]:
        assert by_id[pid]["counterChecked"] == [{"claim": "creditBottom20", "expected": True}]
    # 신용평점은 창구 조회 항목이라 증명서로 요청하는 항목(/claims)에는 없다
    assert "creditBottom20" not in {c["claim"] for c in client.get("/claims").json()}


def test_policy_check_sunshine_general_from_vc_only(env):
    client, _, holder, _ = env
    res = _present_preset(client, holder, [_vc(holder.did, "annualIncomeUnder35M", 31)], "sunshine-general")
    assert res["verdict"] == "PASS", res
    assert res["policyCheck"] == {"policyId": "sunshine-loan-general", "eligible": True, "pending": [],
                                  "counterChecked": []}


def test_policy_check_low_credit_uses_counter_checked_credit(env):
    """신용 하위 20% 경로: 증명서는 '연소득 4,500만 원 이하' 하나, 신용평점은 창구 조회값으로 판정에 들어간다."""
    client, _, holder, _ = env
    for verifier_id in ["imbank-branch-01", "im-savings-01"]:
        res = _present_preset(client, holder, [_vc(holder.did, "annualIncomeUnder45M", 32)],
                              "sunshine-general-low-credit", verifier_id)
        assert res["verdict"] == "PASS", res
        assert res["claims"] == {"annualIncomeUnder45M": True}
        assert res["policyCheck"] == {
            "policyId": "sunshine-loan-general", "eligible": True, "pending": [],
            "counterChecked": [{"claim": "creditBottom20", "expected": True,
                                "label": BUNDLE["claims"]["labels"]["creditBottom20"]}],
        }
        assert res["comparison"]["presetId"] == "sunshine-general-low-credit"
        assert res["comparison"]["pullCount"] == 10 and res["comparison"]["holdCount"] == 1
    res = _present_preset(client, holder, [_vc(holder.did, "annualIncomeUnder50M", 33)], "new-hope-low-credit")
    assert res["verdict"] == "PASS", res
    assert res["policyCheck"]["policyId"] == "new-hope-loan" and res["policyCheck"]["eligible"] is True
    assert [c["claim"] for c in res["policyCheck"]["counterChecked"]] == ["creditBottom20"]


def test_policy_check_does_not_fill_unsubmitted_claims_with_false(env):
    """차상위계층 = 50% 이하 AND 수급자 아님. '50% 이하'만 제출되면 수급 여부를 모르므로 적격으로 단정하지 않는다."""
    client, _, holder, vcs = env
    req = client.post("/requests", json={"policyId": "near-poor", "purpose": "차상위계층 확인",
                                         "requested": [{"claim": "incomeBelow50Median", "expected": True}]}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                   nonce=req["nonce"], vc_jwts=[vcs[1]])
    res = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert res["verdict"] == "PASS", res
    assert res["policyCheck"] == {
        "policyId": "near-poor", "eligible": None,
        "pending": [{"claim": "isBenefitRecipient", "label": BUNDLE["claims"]["labels"]["isBenefitRecipient"],
                     "counterCheck": False}],
        "counterChecked": [],
    }


def test_policy_check_marks_counter_only_pending_and_ignores_unrelated_counter_checked(env):
    """프리셋 없이 햇살론에 4,500만 원만 내면 판정 보류: 3,500만 원(미제출)과 신용평점(창구 조회)을 구분해 돌려준다.
    다른 정책의 프리셋 창구 확인값은 이 정책 판정에 끼어들지 않는다."""
    client, _, holder, _ = env
    req = client.post("/requests", json={"policyId": "sunshine-loan-general", "purpose": "햇살론 일반보증 대상 확인",
                                         "requested": [{"claim": "annualIncomeUnder45M", "expected": True}]}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                   nonce=req["nonce"], vc_jwts=[_vc(holder.did, "annualIncomeUnder45M", 34)])
    pc = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()["policyCheck"]
    assert pc["eligible"] is None and pc["counterChecked"] == []
    assert {p["claim"]: p["counterCheck"] for p in pc["pending"]} == {"annualIncomeUnder35M": False, "creditBottom20": True}

    req = client.post("/requests", json={"presetId": "sunshine-general-low-credit", "policyId": "near-poor",
                                         "purpose": "차상위계층 확인",
                                         "requested": [{"claim": "incomeBelow50Median", "expected": True}]}).json()
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=req["verifier"],
                   nonce=req["nonce"], vc_jwts=[_vc(holder.did, "incomeBelow50Median", 35)])
    pc = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()["policyCheck"]
    assert pc["policyId"] == "near-poor" and pc["counterChecked"] == []


def test_unknown_policy_id_rejected_before_nonce_is_used(env):
    """규칙 묶음에 없는 정책(예: 2026.1 의 sunshine-loan-bank)은 요청 단계에서 거절한다 — 제출 시 500 이 나지 않게."""
    client, _, _, _ = env
    r = client.post("/requests", json={"policyId": "sunshine-loan-bank", "purpose": "햇살론뱅크 대상 확인",
                                       "requested": [{"claim": "annualIncomeUnder35M", "expected": True}]})
    assert r.status_code == 400 and r.json()["detail"] == "POLICY_UNKNOWN"


def test_low_credit_new_hope_not_offered_at_savings_bank(env):
    client, _, _, _ = env
    r = client.post("/requests", json={"verifierId": "im-savings-01", "presetId": "new-hope-low-credit",
                                       "purpose": "새희망홀씨 대상 확인 (신용평점 하위 20%)",
                                       "requested": [{"claim": "annualIncomeUnder50M", "expected": True}]})
    assert r.status_code == 400 and r.json()["detail"] == "PRESET_NOT_OFFERED"


def test_comparison_lists_low_credit_presets(env):
    client, _, _, _ = env
    presets = client.get("/comparison").json()["presets"]
    assert list(presets) == ["consult", "sunshine-general", "sunshine-general-low-credit", "new-hope",
                             "new-hope-low-credit", "discount"]
    for pid, hold in [("sunshine-general-low-credit", "연소득 4,500만 원 이하 여부 = 참"),
                      ("new-hope-low-credit", "연소득 5,000만 원 이하 여부 = 참")]:
        c = presets[pid]
        assert [d["name"] for d in c["pullDocuments"]] == ["소득금액증명"], pid
        assert c["pullCount"] == 10 and c["holdCount"] == 1 and c["reductionPercent"] == 90, pid
        assert c["holdItems"] == [hold], pid
        one = client.get(f"/comparison/{pid}").json()
        assert one["pullCount"] == 10 and one["holdCount"] == 1, pid
