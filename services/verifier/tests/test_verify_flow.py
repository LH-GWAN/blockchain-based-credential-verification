"""검증 절차 테스트: 정상 PASS, 폐기·재사용·만료·위조·타인 증명서·비활성 발급기관·미등록 발급기관 차단.

VC 는 번들 issuerOf 대로 소관 발급기관 키로 서명한다 (거주·연령 = 대구시, 소득·수급 = 복지기관)."""
import base64
import json
import time

import pytest
from dbp_rules import bundle_hash, load_bundle
from dbp_vc import (
    create_status_list,
    create_vp,
    encode_status_list,
    generate_holder_key,
    issue_vc,
    set_status,
    sha256_hex,
)
from dbp_verifier.app import create_app
from dbp_verifier.config import REASON_KO, Settings, parse_accepted_bundles
from dbp_verifier.verify import CHECK_KEYS, LedgerUnavailable, confirm_code
from fastapi.testclient import TestClient

BUNDLE = load_bundle()
BHASH = bundle_hash(BUNDLE)
ISSUER = generate_holder_key(bytes([1]) * 32)
ISSUER_DID = "did:dbp:daegu"
WELFARE = generate_holder_key(bytes([3]) * 32)
WELFARE_DID = "did:dbp:welfare"
KEYS = {ISSUER_DID: ISSUER, WELFARE_DID: WELFARE}
CONTROLLERS = {ISSUER_DID: "0x00000000000000000000000000000000000000D1", WELFARE_DID: "0x00000000000000000000000000000000000000E1"}
VERIFIER_DIDS = {"imbank-branch-01": "did:dbp:verifier-imbank-branch-01", "im-savings-01": "did:dbp:verifier-im-savings-01"}


def _list_id(issuer_did):
    return f"dbp:status:{issuer_did.split(':')[-1]}:list-1"


class FakeLedger:
    def __init__(self):
        self.issuers = {
            ISSUER_DID: {"did": ISSUER_DID, "ed25519PubKey": ISSUER.public_key, "name": "대구광역시",
                         "controller": CONTROLLERS[ISSUER_DID], "active": True, "registeredAt": 0},
            WELFARE_DID: {"did": WELFARE_DID, "ed25519PubKey": WELFARE.public_key, "name": "사회보장정보원(복지기관)",
                          "controller": CONTROLLERS[WELFARE_DID], "active": True, "registeredAt": 0},
        }
        self.bits = {d: create_status_list(131072) for d in KEYS}
        # 원장은 체크섬 주소를 돌려줄 수 있다 — 대소문자 차이는 같은 주소
        self.lists = {_list_id(d): {"encodedList": encode_status_list(self.bits[d]), "version": 1, "updatedAt": 0,
                                    "owner": CONTROLLERS[d].lower()} for d in KEYS}
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

    def revoke(self, index, issuer_did=WELFARE_DID):
        set_status(self.bits[issuer_did], index, True)
        lst = self.lists[_list_id(issuer_did)]
        lst.update(encodedList=encode_status_list(self.bits[issuer_did]), version=lst["version"] + 1)

    def anchor_receipt(self, h, kind):
        self.receipts[h] = kind
        return "0xfaketx"


def _vc(holder_did, claim, index, issuer_key=None, valid_until="2027-09-14T00:00:00Z", valid_from="2026-09-01T00:00:00Z",
        bhash=BHASH, issuer_did=None, version="2026.2", value=True):
    issuer_did = issuer_did or BUNDLE["claims"]["issuerOf"][claim]  # 기본은 소관 발급기관
    issuer_key = issuer_key or KEYS[issuer_did]
    return issue_vc(id=f"urn:uuid:{claim}-{index}", issuer_did=issuer_did, issuer_kid=issuer_did + "#key-1",
                    issuer_private_key=issuer_key.private_key, holder_did=holder_did, claim={"name": claim, "value": value},
                    valid_from=valid_from, valid_until=valid_until, status={"listId": _list_id(issuer_did), "index": index},
                    evidence={"bundle": "daegu-eligibility", "version": version, "bundleHash": bhash})


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
    assert res["issuers"]["incomeBelow50Median"] == "사회보장정보원(복지기관)"
    assert res["claims"] == {"daeguResident": True, "incomeBelow50Median": True}
    assert res["issuers"]["daeguResident"] == "대구광역시"
    assert res["timingsMs"]["total"] < 2000
    assert set(res["checks"]) == set(CHECK_KEYS) and len(CHECK_KEYS) == 11 and all(res["checks"].values())
    assert res["confirmCode"] == confirm_code(_vp) and len(res["confirmCode"]) == 4 and res["otherAttempts"] == 0
    # 제출 영수증 앵커 (TestClient 는 background task 를 동기 실행)
    done = client.get(f"/results/{req['requestId']}", headers={"X-Counter-Token": req["counterToken"]}).json()
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
    assert atk["reasonCodes"] == ["NONCE_REUSED"]
    # 공격 시연은 원래 요청의 PASS 결과를 덮어쓰지 않는다
    orig = client.get(f"/results/{req['requestId']}", headers={"X-Counter-Token": req["counterToken"]}).json()
    assert orig["verdict"] == "PASS" and orig["otherAttempts"] == 2  # 재제출 1 + 재사용 공격 1


def test_revoked_blocked(env):
    client, ledger, holder, vcs = env
    ledger.revoke(11)
    _, _, res = _present(client, holder, vcs)
    assert res["verdict"] == "FAIL" and res["reasonCodes"] == ["REVOKED"]
    assert res["checks"]["notRevoked"] is False and res["checks"]["vcSignature"] is True


def test_forged_and_wrong_holder(env):
    client, _ledger, holder, vcs = env
    _present(client, holder, vcs)
    # 공격 하나에 사유 하나 (F29) — 다른 사유가 섞여 있으면 그 검사가 고장 나도 FAIL 로 보이기 때문
    forged = client.post("/demo/attack", json={"kind": "forged"}).json()
    assert forged["verdict"] == "FAIL" and forged["reasonCodes"] == ["VC_SIG_INVALID"], forged
    assert forged["resultId"] and "policyCheck" not in forged
    wrong = client.post("/demo/attack", json={"kind": "wrong-holder"}).json()
    assert wrong["verdict"] == "FAIL" and wrong["reasonCodes"] == ["HOLDER_MISMATCH"], wrong
    expired = client.post("/demo/attack", json={"kind": "expired"}).json()
    assert expired["verdict"] == "FAIL" and expired["reasonCodes"] == ["NONCE_EXPIRED"], expired


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
    assert "공식 서식" in c["honestyNote"] and "공공 마이데이터" in c["honestyNote"]
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


# ───────────────────────── 코드 리뷰(2026-10-09) 반영 ─────────────────────────

def _token(req):
    return {"X-Counter-Token": req["counterToken"]}


def _vp_for(holder, req, vcs, aud=None):
    return create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=aud or req["verifier"],
                     nonce=req["nonce"], vc_jwts=vcs)


def _jwt(payload, header=None):
    seg = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
    return f"{seg(header or {'alg': 'EdDSA', 'typ': 'vp+jwt'})}.{seg(payload)}.c2ln"


def test_counter_token_kept_out_of_qr_and_code_lookup(env):
    """F03: 창구 토큰은 POST /requests 응답에만 있고 QR·코드 조회에는 없다. 사용·만료된 코드는 404."""
    client, _, holder, vcs = env
    req = client.post("/requests", json={}).json()
    assert len(req["counterToken"]) == 32
    assert "counterToken" not in json.loads(req["qrText"])
    looked = client.get(f"/requests/{req['shortCode']}")
    assert looked.status_code == 200 and "counterToken" not in looked.json() and looked.json()["nonce"] == req["nonce"]
    client.post("/present", json={"requestId": req["requestId"], "vpJwt": _vp_for(holder, req, vcs)})
    for key in (req["shortCode"], req["requestId"]):
        r = client.get(f"/requests/{key}")
        assert r.status_code == 404 and r.json()["detail"] == "REQUEST_UNKNOWN"


def test_expired_request_lookup_is_404(env, monkeypatch):
    import dbp_verifier.app as app_mod
    client, _, _, _ = env
    req = client.post("/requests", json={}).json()
    real = app_mod.time.time
    monkeypatch.setattr(app_mod.time, "time", lambda: real() + 600)
    assert client.get(f"/requests/{req['shortCode']}").status_code == 404


def test_code_enumeration_rate_limited(env):
    """F03: 같은 IP 에서 60초 안에 404 가 20번 쌓이면 이후 조회는 429. 성공한 조회는 세지 않는다."""
    client, _, _, _ = env
    req = client.post("/requests", json={}).json()
    for _ in range(5):
        assert client.get(f"/requests/{req['shortCode']}").status_code == 200
    codes = [c for c in (f"{n:06d}" for n in range(100000, 100100)) if c != req["shortCode"]]
    statuses = [client.get(f"/requests/{c}").status_code for c in codes[:21]]
    assert statuses[:20] == [404] * 20 and statuses[20] == 429
    r = client.get(f"/requests/{req['shortCode']}")
    assert r.status_code == 429 and r.json()["detail"] == "TOO_MANY_LOOKUPS"


def test_results_require_counter_token_or_vp_hash(env):
    """F03: /results 는 창구 토큰(X-Counter-Token) 또는 그 VP 해시(X-Vp-Hash)가 있어야 본다."""
    client, _, holder, vcs = env
    req = client.post("/requests", json={}).json()
    rid = req["requestId"]
    assert client.get(f"/results/{rid}").status_code == 401
    assert client.get(f"/results/{rid}").json()["detail"] == "RESULT_AUTH_REQUIRED"
    pending = client.get(f"/results/{rid}", headers=_token(req)).json()
    assert pending == {"requestId": rid, "status": "pending", "exp": req["exp"]}
    assert client.get(f"/results/{rid}", headers={"X-Vp-Hash": "0x" + "00" * 32}).json() == {"requestId": rid, "status": "pending"}
    vp = _vp_for(holder, req, vcs)
    client.post("/present", json={"requestId": rid, "vpJwt": vp})
    bad = client.get(f"/results/{rid}", headers={"X-Counter-Token": "0" * 32})
    assert bad.status_code == 403 and bad.json()["detail"] == "RESULT_FORBIDDEN"
    assert client.get(f"/results/{rid}", headers={"X-Vp-Hash": "0x" + "00" * 32}).status_code == 403
    mine = client.get(f"/results/{rid}", headers={"X-Vp-Hash": "0x" + sha256_hex(vp)}).json()
    assert mine["status"] == "done" and mine["verdict"] == "PASS" and mine["confirmCode"] == confirm_code(vp)
    assert client.get("/results/r_unknown", headers=_token(req)).status_code == 404
    # 다른 요청의 토큰으로는 볼 수 없다
    other = client.post("/requests", json={}).json()
    assert client.get(f"/results/{rid}", headers=_token(other)).status_code == 403


def test_garbage_first_submission_cannot_take_counter_result(env):
    """F08: 서명이 틀리거나 aud 가 다른 제출은 nonce 를 소모하지 않고 'rid#rejected-…' 에만 남는다.
    시민의 정상 제출은 그 뒤에도 PASS 로 results[rid] 에 들어가고, 창구는 추가 시도 수를 본다."""
    client, _, holder, vcs = env
    req = client.post("/requests", json={}).json()
    rid = req["requestId"]
    attacker = generate_holder_key(bytes([9]) * 32)
    # 1) 서명이 깨진 VP
    good = _vp_for(holder, req, vcs)
    h, p, sig = good.split(".")
    broken = ".".join([h, p, ("A" if sig[0] != "A" else "B") + sig[1:]])
    r1 = client.post("/present", json={"requestId": rid, "vpJwt": broken}).json()
    assert r1["reasonCodes"] == ["VP_SIG_INVALID"] and r1["resultId"].startswith(rid + "#rejected-")
    assert r1["checks"]["nonce"] is False and r1["receipt"]["txHash"] is None and r1["receipt"]["error"]
    # 2) 공격자 키로 정상 서명했지만 다른 기관(aud)으로 보낸 VP
    r2 = client.post("/present", json={"requestId": rid, "vpJwt": _vp_for(attacker, req, [], aud="did:dbp:elsewhere")}).json()
    assert r2["reasonCodes"] == ["AUD_MISMATCH"] and r2["resultId"].startswith(rid + "#rejected-")
    assert client.get(f"/results/{rid}", headers=_token(req)).json()["status"] == "pending"
    # 3) 시민의 정상 제출은 여전히 통과하고 창구 결과 자리에 들어간다
    ok = client.post("/present", json={"requestId": rid, "vpJwt": good}).json()
    assert ok["verdict"] == "PASS" and ok["resultId"] == rid and ok["otherAttempts"] == 2
    shown = client.get(f"/results/{rid}", headers=_token(req)).json()
    assert shown["verdict"] == "PASS" and shown["otherAttempts"] == 2


def test_fail_result_has_no_policy_check_and_no_unverified_values(env):
    """F09: FAIL 이면 policyCheck 가 없고, 검증에 실패한 VC 의 값은 돌려주지 않는다."""
    client, ledger, holder, _ = env
    ledger.revoke(41)
    res = _present_preset(client, holder, [_vc(holder.did, "annualIncomeUnder35M", 41)], "sunshine-general")
    assert res["verdict"] == "FAIL" and res["reasonCodes"] == ["REVOKED"]
    assert "policyCheck" not in res and res["claims"] == {}
    assert res["credentials"][0]["claim"] == "annualIncomeUnder35M" and res["credentials"][0]["value"] is None
    assert res["checks"]["notRevoked"] is False and res["checks"]["requestedClaims"] is False


def test_issuer_must_be_authoritative_for_claim(env):
    """F11: 복지기관 키로 서명한 '대구 거주' VC 는 등록·서명이 유효해도 소관 기관이 아니므로 FAIL."""
    client, _, holder, vcs = env
    wrong = _vc(holder.did, "daeguResident", 51, issuer_did=WELFARE_DID)
    _, _, res = _present(client, holder, [wrong, vcs[1]])
    assert res["verdict"] == "FAIL" and res["reasonCodes"] == ["ISSUER_NOT_AUTHORITATIVE"]
    assert res["checks"]["issuerAuthoritative"] is False and res["checks"]["vcSignature"] is True
    assert "daeguResident" not in res["claims"]


def test_used_is_checked_before_expired(env, monkeypatch):
    """F28: 이미 쓴 요청은 시간이 지나도 '재사용'으로, 만료 공격 뒤에도 재사용 공격은 NONCE_REUSED."""
    import dbp_verifier.app as app_mod
    client, _, holder, vcs = env
    req, vp, res = _present(client, holder, vcs)
    assert res["verdict"] == "PASS"
    assert client.post("/demo/attack", json={"kind": "expired"}).json()["reasonCodes"] == ["NONCE_EXPIRED"]
    assert client.post("/demo/attack", json={"kind": "replay"}).json()["reasonCodes"] == ["NONCE_REUSED"]
    assert client.post("/demo/attack", json={"kind": "expired"}).json()["reasonCodes"] == ["NONCE_EXPIRED"]
    real = app_mod.time.time
    monkeypatch.setattr(app_mod.time, "time", lambda: real() + 600)  # TTL 120초가 지난 뒤
    again = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert again["reasonCodes"] == ["NONCE_REUSED"]


def test_attacks_use_claims_of_last_pass_request(env):
    """F29: 위조·타인 공격은 직전 PASS 요청과 같은 창구·항목으로 요청을 만든다 (CLAIM_MISSING 이 섞이지 않게)."""
    client, _, holder, _ = env
    res = _present_preset(client, holder, [_vc(holder.did, "annualIncomeUnder35M", 61)], "sunshine-general", "im-savings-01")
    assert res["verdict"] == "PASS"
    for kind, code in [("forged", "VC_SIG_INVALID"), ("wrong-holder", "HOLDER_MISMATCH")]:
        atk = client.post("/demo/attack", json={"kind": kind}).json()
        assert atk["reasonCodes"] == [code], atk
        assert [r["claim"] for r in atk["requested"]] == ["annualIncomeUnder35M"]
        assert atk["verifier"]["did"] == VERIFIER_DIDS["im-savings-01"]


def test_attack_response_does_not_unlock_citizen_result(env):
    """인증 없는 공격 시연 응답에 VP 해시·솔트·증명서 번호·상태 인덱스가 없고, 그 응답만으로는 시민 결과를 열 수 없다."""
    client, _, holder, vcs = env
    req, _, res = _present(client, holder, vcs)
    assert res["verdict"] == "PASS"
    for kind in ["replay", "expired", "forged", "wrong-holder"]:
        atk = client.post("/demo/attack", json={"kind": kind}).json()
        obj = atk["receipt"]["object"]
        assert "vpHash" not in obj and "salt" not in obj, kind
        assert all("jti" not in c and "statusListIndex" not in c for c in atk["credentials"]), kind
        assert "holderDidShort" not in atk
    # 시민 VP 해시를 알더라도 공격 기록('#attack-')은 지갑 조회 경로로 나가지 않는다
    vp_hash = res["receipt"]["object"]["vpHash"]
    r = client.get(f"/results/{req['requestId']}", headers={"X-Vp-Hash": vp_hash})
    assert r.status_code == 200 and r.json()["resultId"] == req["requestId"]
    counter = client.get(f"/results/{req['requestId']}", headers={"X-Counter-Token": req["counterToken"]}).json()
    assert counter["otherAttempts"] == 2  # 재사용·만료 공격 2건(위조·타인은 새 요청)은 창구 화면에서만 보인다


def test_other_attempts_does_not_count_itself(env):
    """'rid#…' 에 저장된 결과의 otherAttempts 는 자기 자신을 세지 않는다."""
    client, _, holder, vcs = env
    req, vp, res = _present(client, holder, vcs)
    assert res["verdict"] == "PASS" and res["otherAttempts"] == 0
    again = client.post("/present", json={"requestId": req["requestId"], "vpJwt": vp}).json()
    assert again["resultId"].startswith(req["requestId"] + "#") and again["otherAttempts"] == 0
    base = client.get(f"/results/{req['requestId']}", headers={"X-Counter-Token": req["counterToken"]}).json()
    assert base["otherAttempts"] == 1


def test_issuer_active_and_not_expired_checks(env):
    """F32: 만료 VC·정지 발급기관이면 해당 체크가 ✗ 로 보인다."""
    client, ledger, holder, vcs = env
    old = _vc(holder.did, "daeguResident", 71, valid_from="2025-01-01T00:00:00Z", valid_until="2026-01-01T00:00:00Z")
    _, _, res = _present(client, holder, [old, vcs[1]])
    assert res["reasonCodes"] == ["EXPIRED"] and res["checks"]["notExpired"] is False and res["checks"]["issuerActive"] is True
    ledger.issuers[ISSUER_DID]["active"] = False
    _, _, res = _present(client, holder, vcs)
    assert res["reasonCodes"] == ["ISSUER_INACTIVE"] and res["checks"]["issuerActive"] is False
    assert res["checks"]["notExpired"] is True


class _DownLedger(FakeLedger):
    def get_issuer(self, did):
        raise LedgerUnavailable("connection refused")

    def get_status_list(self, list_id):
        raise LedgerUnavailable("connection refused")

    def get_bundle(self, bundle, version):
        raise LedgerUnavailable("connection refused")


class _StalledLedger(FakeLedger):
    def get_issuer(self, did):
        time.sleep(1.5)
        return super().get_issuer(did)


def test_ledger_outage_is_not_reported_as_forgery(env):
    """F33: 원장 연결 실패는 LEDGER_UNAVAILABLE 하나로 — '미등록 발급기관'·'증명서 없음'·'위조'가 아니다."""
    _, _, holder, vcs = env
    client = TestClient(create_app(ledger=_DownLedger()))
    _, _, res = _present(client, holder, vcs)
    assert res["verdict"] == "FAIL" and res["reasonCodes"] == ["LEDGER_UNAVAILABLE"]
    assert [c["claim"] for c in res["credentials"]] == ["daeguResident", "incomeBelow50Median"]


def test_missing_ledger_client_is_unavailable_not_forged(env, monkeypatch):
    import dbp_verifier.app as app_mod
    monkeypatch.setattr(app_mod, "build_ledger", lambda settings: None)
    _, _, holder, vcs = env
    client = TestClient(create_app())
    _, _, res = _present(client, holder, vcs)
    assert res["reasonCodes"] == ["LEDGER_UNAVAILABLE"]
    assert client.get("/health").json()["ledgerConnected"] is False


def test_stalled_ledger_hits_deadline(env):
    """F34: 원장이 멈춰도 검증 1건은 데드라인 안에 LEDGER_UNAVAILABLE 로 끝난다 (지갑 10초 타임아웃 전에)."""
    _, _, holder, vcs = env
    settings = Settings()
    settings.ledger_deadline_s = 0.3
    client = TestClient(create_app(settings, ledger=_StalledLedger()))
    t0 = time.perf_counter()
    _, _, res = _present(client, holder, vcs)
    assert time.perf_counter() - t0 < 1.2
    assert res["reasonCodes"] == ["LEDGER_UNAVAILABLE"]


@pytest.mark.parametrize("requested", [[], [{"claim": "daeguResident"}, {"claim": "daeguResident"}],
                                       [{"claim": "creditBottom20"}], [{"claim": "noSuchClaim"}]])
def test_invalid_requested_rejected(env, requested):
    """F35: 빈 요청·중복·창구 자체 조회 항목(self)·없는 항목은 400 REQUESTED_INVALID."""
    client, _, _, _ = env
    r = client.post("/requests", json={"requested": requested})
    assert r.status_code == 400 and r.json()["detail"] == "REQUESTED_INVALID"


def test_unrequested_credential_fails_and_is_not_stored(env):
    """F36: 요청하지 않은 VC 를 함께 내면 FAIL, 그 항목은 결과에 남지 않는다."""
    client, _, holder, vcs = env
    extra = _vc(holder.did, "incomeBelow32Median", 81)
    req = client.post("/requests", json={"requested": [{"claim": "daeguResident", "expected": True}]}).json()
    res = client.post("/present", json={"requestId": req["requestId"], "vpJwt": _vp_for(holder, req, [vcs[0], extra])}).json()
    assert res["verdict"] == "FAIL" and res["reasonCodes"] == ["UNREQUESTED_CREDENTIAL"]
    assert "incomeBelow32Median" not in json.dumps(res) and res["checks"]["requestedClaims"] is False


@pytest.mark.parametrize("payload", [[1], {"vp": "str", "aud": "x", "nonce": "n"}, {"vp": {"verifiableCredential": [1]}}])
def test_malformed_vp_is_rejected_without_500(env, payload):
    """F37: payload·vp 가 객체가 아니면 500 이 아니라 VP_MALFORMED, nonce 도 그대로 남는다."""
    client, _, holder, vcs = env
    req = client.post("/requests", json={}).json()
    r = client.post("/present", json={"requestId": req["requestId"], "vpJwt": _jwt(payload)})
    assert r.status_code == 200 and r.json()["reasonCodes"] == ["VP_MALFORMED"]
    assert set(r.json()["checks"]) == set(CHECK_KEYS) and not any(r.json()["checks"].values())
    ok = client.post("/present", json={"requestId": req["requestId"], "vpJwt": _vp_for(holder, req, vcs)}).json()
    assert ok["verdict"] == "PASS"


def test_confirm_code_vector():
    """F39: 지갑(TS)과 같은 식 — sha256(vpJwt) 앞 8자리 16진수 % 10000, 4자리."""
    assert confirm_code("abc") == "2319"  # sha256("abc") = ba7816bf…
    assert confirm_code("x") == str(int(sha256_hex("x")[:8], 16) % 10000).zfill(4)


def test_rule_version_must_be_accepted(env):
    """F43: 창구가 받는 규칙 버전(ACCEPTED_BUNDLES)이 아니면 원장 해시가 맞아도 FAIL."""
    client, _, holder, vcs = env
    old = _vc(holder.did, "daeguResident", 91, version="2026.1")
    _, _, res = _present(client, holder, [old, vcs[1]])
    assert res["reasonCodes"] == ["RULE_VERSION_NOT_ACCEPTED"] and res["checks"]["ruleVersion"] is False
    assert parse_accepted_bundles("daegu-eligibility@2026.1, daegu-eligibility@2026.2") == {
        "daegu-eligibility": ["2026.1", "2026.2"]}
    assert parse_accepted_bundles("") == {"daegu-eligibility": ["2026.2"]}
    settings = Settings()
    settings.accepted_bundles = parse_accepted_bundles("daegu-eligibility@2026.1,daegu-eligibility@2026.2")
    _, _, res = _present(TestClient(create_app(settings, ledger=FakeLedger())), holder, [old, vcs[1]])
    assert res["verdict"] == "PASS", res


def test_status_list_owner_must_be_issuer_controller(env):
    """F60: 상태 목록 게시자가 발급기관 컨트롤러와 다르면 폐기 비트를 믿지 않는다."""
    client, ledger, holder, vcs = env
    ledger.lists[_list_id(WELFARE_DID)]["owner"] = CONTROLLERS[ISSUER_DID]
    _, _, res = _present(client, holder, vcs)
    assert res["reasonCodes"] == ["STATUS_LIST_OWNER_MISMATCH"] and res["checks"]["notRevoked"] is False


def test_cors_allows_only_configured_origins(env):
    client, _, _, _ = env
    ok = client.get("/health", headers={"Origin": "http://localhost:3001"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3001"
    bad = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in bad.headers


def test_reason_texts_and_copy_fixes(env):
    """새 사유 코드의 한국어 문구, 공공요금 프리셋 안내(F48), 비교 패널 '남는 기록'(F13)."""
    client, _, _, _ = env
    for code in ["ISSUER_NOT_AUTHORITATIVE", "UNREQUESTED_CREDENTIAL", "LEDGER_UNAVAILABLE", "RULE_VERSION_NOT_ACCEPTED",
                 "STATUS_LIST_OWNER_MISMATCH", "REQUESTED_INVALID", "TOO_MANY_LOOKUPS", "RESULT_AUTH_REQUIRED",
                 "RESULT_FORBIDDEN"]:
        assert REASON_KO[code]
    discount = next(p for p in client.get("/presets").json() if p["id"] == "discount")
    assert "수급자증명서" not in discount["hint"] and "소득금액증명·주민등록표 등본" in discount["hint"]
    c = client.get("/comparison/discount").json()
    assert [d["name"] for d in c["pullDocuments"]] == ["소득금액증명", "주민등록표 등본"]
    assert c["holdRecords"].startswith("원장에 제출 영수증의 솔트 해시 1건") and "없음" not in c["holdRecords"][:3]
    assert client.get("/comparison").json()["records"]["hold"] == c["holdRecords"]
    for banned in ["유출 불가", "개인정보가 사라진다", "종이를 없앤다", "행정기관 사이에서만 작동"]:
        assert banned not in json.dumps(c, ensure_ascii=False)


def test_empty_allowed_origins_falls_back_to_defaults(monkeypatch):
    """compose 처럼 ALLOWED_ORIGINS="" 를 넘겨도 CORS 가 전부 막히지 않는다 (기본 출처 사용)."""
    from dbp_verifier.config import DEFAULT_ALLOWED_ORIGINS, Settings
    monkeypatch.setenv("ALLOWED_ORIGINS", "")
    assert Settings().allowed_origins == DEFAULT_ALLOWED_ORIGINS.split(",")
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://phone.test:3000")
    assert Settings().allowed_origins == ["http://phone.test:3000"]
