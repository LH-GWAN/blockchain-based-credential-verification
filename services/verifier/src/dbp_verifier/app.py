from __future__ import annotations

import copy
import hmac
import json
import logging
import secrets
import threading
import time
import uuid
from collections import deque
from typing import Literal

from dbp_rules import evaluate_policy_partial, load_bundle, rule_vars
from dbp_vc import (
    b64url_decode,
    b64url_encode,
    create_vp,
    generate_holder_key,
    random_salt,
    receipt_hash,
    sha256_hex,
)
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .comparison import build_comparison, precomputed
from .config import PRESETS, REASON_KO, VERIFIERS, Settings
from .verify import confirm_code, decode_jwt_unverified, verify_presentation

log = logging.getLogger("dbp_verifier")
KIND_PRESENTATION = 2


class RequestedClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")
    claim: str
    expected: bool = True


class RequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verifierId: str | None = None
    purpose: str = "서민금융 상담 대상 확인"
    requested: list[RequestedClaim] = Field(default_factory=lambda: [RequestedClaim(claim="daeguResident"), RequestedClaim(claim="incomeBelow50Median")])
    policyId: str | None = None
    presetId: str | None = None


class PresentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str | None = None
    vpJwt: str = Field(max_length=200_000)


class AttackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["replay", "expired", "forged", "wrong-holder"]


def build_ledger(settings: Settings):
    try:
        from dbp_ledger import LedgerClient
        lc = LedgerClient(rpc_url=settings.rpc_url, private_key=settings.evm_private_key)
        if not lc.is_connected():
            log.warning("ledger not reachable at %s", settings.rpc_url)
        return lc
    except Exception as e:  # noqa: BLE001 — 원장 없이도 서비스는 뜬다
        log.warning("ledger client unavailable: %s", e)
        return None


def create_app(settings: Settings | None = None, ledger=None) -> FastAPI:
    settings = settings or Settings()
    ledger_ref: dict[str, object] = {"ledger": ledger if ledger is not None else build_ledger(settings), "retry_at": 0.0}
    bundle = load_bundle()
    labels = bundle["claims"]["labels"]
    issuer_of: dict[str, str] = bundle["claims"]["issuerOf"]
    app = FastAPI(title="대구 혜택패스 검증기관", version="0.1.0")
    # 창구 화면·지갑 주소만 허용 (F03). 다른 주소에서 띄우면 ALLOWED_ORIGINS 로 더한다.
    app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_methods=["*"], allow_headers=["*"])

    requests: dict[str, dict] = {}
    by_code: dict[str, str] = {}  # 6자리 코드 → requestId. 사용·만료되면 지운다.
    results: dict[str, dict] = {}  # rid → nonce 를 소모한 제출 결과, "rid#…" → 그 밖의 제출 시도
    last: dict[str, object] = {}  # lastVp, lastRequestId
    lookup_fails: dict[str, deque[float]] = {}  # IP → 404 로 끝난 코드 조회 시각
    lock = threading.Lock()
    attack_lock = threading.Lock()  # 만료 공격의 상태 저장·복원 직렬화 (F28)
    attacker = generate_holder_key(bytes([0xAA]) * 32)  # 시연용 공격자 키

    def get_ledger():
        """시작할 때 원장 클라이언트를 못 만들었으면 5초에 한 번 다시 시도한다 (F33)."""
        if ledger_ref["ledger"] is None and time.monotonic() >= ledger_ref["retry_at"]:
            ledger_ref["retry_at"] = time.monotonic() + 5
            ledger_ref["ledger"] = build_ledger(settings)
        return ledger_ref["ledger"]

    def purge_codes() -> None:
        """만료된 요청의 코드를 지운다 (lock 안에서 부른다)."""
        now = time.time()
        for code in [c for c, rid in by_code.items() if requests[rid]["exp"] < now]:
            del by_code[code]

    def nonce_lookup_factory(request_id: str):
        def lookup(nonce: str) -> str:
            with lock:
                req = requests.get(request_id)
                if not req or req["nonce"] != nonce:
                    return "unknown"
                if req["used"]:  # 사용 여부를 만료보다 먼저 본다 — 재사용은 시간이 지나도 '재사용'으로 (F28)
                    return "used"
                if req["exp"] < time.time():
                    return "expired"
                req["used"] = True
                by_code.pop(req["shortCode"], None)
                return "ok"
        return lookup

    def find_request_by_nonce(nonce: str) -> str | None:
        for rid, r in requests.items():
            if r["nonce"] == nonce:
                return rid
        return None

    def other_attempts(rid: str) -> int:
        base = rid.split("#", 1)[0]
        return sum(1 for k in list(results) if k.startswith(base + "#") and k != rid)

    def serve(result: dict) -> dict:
        return {**result, "otherAttempts": other_attempts(result["resultId"])}

    def anchor_receipt(key: str, h: str) -> None:
        receipt = results[key]["receipt"]
        lc = get_ledger()
        if not lc:
            receipt["error"] = "LEDGER_UNAVAILABLE"
            return
        try:
            receipt["txHash"] = lc.anchor_receipt(h, KIND_PRESENTATION)
        except Exception as e:  # noqa: BLE001 — 앵커 실패는 결과에 적고 넘어간다
            log.warning("receipt anchor failed: %s", e)
            receipt["txHash"] = None
            receipt["error"] = str(e)

    def run_present(request_id: str, vp_jwt: str, background: BackgroundTasks | None, store_as: str | None = None) -> dict:
        """결과 저장 키: nonce 를 소모한 제출만 rid, 나머지는 'rid#rejected-…' (F08).
        store_as 가 주어지면 그 키로 저장한다 (공격 시연이 원래 요청의 결과를 덮어쓰지 않도록)."""
        req = requests.get(request_id)
        if not req:
            raise HTTPException(404, "REQUEST_UNKNOWN")
        vdid = req["verifier"]["did"]
        out = verify_presentation(vp_jwt, verifier_did=vdid, requested=req["requested"],
                                  nonce_lookup=nonce_lookup_factory(request_id), ledger=get_ledger(),
                                  issuer_of=issuer_of, accepted_bundles=settings.accepted_bundles,
                                  deadline_s=settings.ledger_deadline_s)
        salt = random_salt()
        receipt_obj = {"kind": "presentation", "vpHash": "0x" + sha256_hex(vp_jwt), "verifierDid": vdid,
                       "nonce": req["nonce"], "ts": int(time.time()), "salt": salt}
        h = receipt_hash(receipt_obj)
        result = {
            "requestId": request_id, "verdict": out.verdict, "reasonCodes": out.reason_codes,
            "reasons": [REASON_KO.get(r, r) for r in out.reason_codes],
            "verifier": req["verifier"], "purpose": req["purpose"],
            "requested": [{**r, "label": labels.get(r["claim"], r["claim"])} for r in req["requested"]],
            "claims": out.claims, "issuers": out.issuers, "credentials": out.credentials,
            "checks": out.checks, "timingsMs": out.timings_ms,
            "holderDidShort": (out.holder_did[:24] + "…") if out.holder_did else "—",
            # 창구 화면과 지갑 화면에 같은 4자리가 보여야 창구 앞 사람의 단말에서 낸 제출이다 (F39)
            "confirmCode": confirm_code(vp_jwt),
            "receipt": {"hash": h, "object": receipt_obj, "txHash": None},
            "verifiedAt": int(time.time()),
        }
        # 조회형 대비 비교 (§12.5): 이번 요청 항목으로 계산 — 숫자를 화면에 하드코딩하지 않는다
        result["comparison"] = build_comparison(req["requested"], labels, req.get("presetId"))
        if req.get("policyId") and out.verdict == "PASS":
            # 정책 판정 재현은 PASS 일 때만 (F09 — FAIL 화면에 '적격'이 함께 뜨지 않게).
            # 제출된 항목 + 창구가 자체 조회한 항목(프리셋 counterChecked)만으로 판정한다.
            # 제출되지 않은 항목을 거짓으로 채우지 않으므로, 결과가 그 항목에 달려 있으면 eligible=None.
            preset = next((p for p in PRESETS if p["id"] == req.get("presetId")), None)
            used = rule_vars(bundle["policies"]["rules"].get(req["policyId"], {}))
            counter = {c["claim"]: c["expected"] for c in (preset or {}).get("counterChecked", [])
                       if preset["policyId"] == req["policyId"] and c["claim"] in used}
            pc = evaluate_policy_partial(bundle, req["policyId"], {**counter, **out.claims})
            result["policyCheck"] = {
                "policyId": req["policyId"], "eligible": pc["eligible"],
                "pending": [{"claim": c, "label": labels.get(c, c), "counterCheck": issuer_of.get(c) == "self"}
                            for c in pc["pending"]],
                "counterChecked": [{"claim": c, "expected": v, "label": labels.get(c, c)} for c, v in counter.items()],
            }
        with lock:
            if store_as:
                key = store_as
            elif out.nonce_consumed:
                key = request_id if request_id not in results else f"{request_id}#replay-{uuid.uuid4().hex[:6]}"
            else:
                key = f"{request_id}#rejected-{uuid.uuid4().hex[:6]}"
            result["resultId"] = key
            if not out.nonce_consumed:
                # 요청을 소모하지 못한 제출(서명·aud 불일치, 재사용·만료)은 원장에 남기지 않는다
                result["receipt"]["error"] = "NOT_ANCHORED"
            results[key] = result
            if out.verdict == "PASS" and store_as is None:
                last["vp"] = vp_jwt
                last["requestId"] = request_id
        if out.nonce_consumed:
            if background is not None:
                background.add_task(anchor_receipt, key, h)
            else:
                anchor_receipt(key, h)
        return serve(result)

    def new_request(body: RequestIn) -> dict:
        verifier_id = body.verifierId or settings.default_verifier
        v = VERIFIERS.get(verifier_id)
        if not v:
            raise HTTPException(400, "VERIFIER_UNKNOWN")
        # 요청 항목: 1개 이상, 중복 없음, VC 로 발급되는 항목(issuerOf 에 있고 창구 자체 조회 'self' 가 아님) (F35)
        claims = [r.claim for r in body.requested]
        if not claims or len(set(claims)) != len(claims) or any(issuer_of.get(c, "self") == "self" for c in claims):
            raise HTTPException(400, "REQUESTED_INVALID")
        # 창구 종류가 취급하지 않는 상품 프리셋(예: 저축은행의 새희망홀씨)은 받지 않는다. policyId 만 보내도 같다.
        offered = [p for p in PRESETS if (body.presetId and p["id"] == body.presetId)
                   or (not body.presetId and body.policyId and p["policyId"] == body.policyId)]
        if offered and all(v["kind"] not in p.get("verifierKinds", [v["kind"]]) for p in offered):
            raise HTTPException(400, "PRESET_NOT_OFFERED")
        if body.policyId and body.policyId not in bundle["policies"]["rules"]:
            raise HTTPException(400, "POLICY_UNKNOWN")  # nonce 를 쓰기 전에 거른다
        rid = "r_" + uuid.uuid4().hex[:12]
        nonce = "n_" + secrets.token_hex(32)
        exp = int(time.time()) + settings.request_ttl_s
        with lock:
            purge_codes()
            code = f"{secrets.randbelow(900000) + 100000}"
            while code in by_code:  # 살아 있는 코드와 겹치지 않게
                code = f"{secrets.randbelow(900000) + 100000}"
            rec = {"requestId": rid, "shortCode": code, "verifier": v, "verifierId": verifier_id, "purpose": body.purpose,
                   "requested": [r.model_dump() for r in body.requested], "policyId": body.policyId,
                   "presetId": body.presetId, "nonce": nonce, "exp": exp, "used": False, "createdAt": int(time.time()),
                   # 창구 화면만 아는 결과 조회 토큰 (F03). QR·코드 조회 응답에는 넣지 않는다.
                   "counterToken": secrets.token_hex(16)}
            requests[rid] = rec
            by_code[code] = rid
        return rec

    def qr_payload(rec: dict) -> dict:
        return {"type": "dbp-presentation-request", "requestId": rec["requestId"], "shortCode": rec["shortCode"],
                "verifier": rec["verifier"]["did"], "verifierName": rec["verifier"]["name"], "purpose": rec["purpose"],
                "requested": [{**r, "label": labels.get(r["claim"], r["claim"])} for r in rec["requested"]],
                "nonce": rec["nonce"], "exp": rec["exp"], "responseUri": settings.public_response_uri}

    @app.get("/health")
    def health():
        lc = get_ledger()
        return {"ok": True, "ledgerConnected": bool(lc and getattr(lc, "is_connected", lambda: True)())}

    @app.get("/verifiers")
    def verifiers():
        return [{"id": k, **v} for k, v in VERIFIERS.items()]

    @app.get("/claims")
    def claims():
        # 창구가 요청할 수 있는 항목 = VC 로 발급되는 사실만 (issuerOf == "self" 제외)
        return [{"claim": c, "label": l} for c, l in labels.items() if issuer_of.get(c) != "self"]

    @app.get("/presets")
    def presets():
        return PRESETS

    @app.get("/comparison")
    def comparison_all():
        """프리셋별 조회형 대비 보유형 비교 (data/comparison.json — scripts/pii_items.py 산출물)."""
        return precomputed()

    @app.get("/comparison/{preset_id}")
    def comparison_one(preset_id: str):
        p = next((x for x in PRESETS if x["id"] == preset_id), None)
        if not p:
            raise HTTPException(404, "PRESET_UNKNOWN")
        return build_comparison(p["requested"], labels, preset_id)

    @app.post("/requests")
    def create_request(body: RequestIn):
        rec = new_request(body)
        p = qr_payload(rec)
        # counterToken 은 QR·qrText 밖에 둔다 — 요청을 만든 창구 화면만 결과를 볼 수 있다
        return {**p, "qrText": json.dumps(p, ensure_ascii=False, separators=(",", ":")), "counterToken": rec["counterToken"]}

    @app.get("/requests/{id_or_code}")
    def get_request(id_or_code: str, request: Request):
        """코드·요청 ID → QR 페이로드. 모르거나 만료·사용된 요청은 404, 404 가 잦은 IP 는 429 (F03 — 코드 열거 차단)."""
        ip = request.client.host if request.client else "unknown"
        now = time.time()
        with lock:
            fails = lookup_fails.setdefault(ip, deque())
            while fails and fails[0] < now - settings.lookup_window_s:
                fails.popleft()
            if len(fails) >= settings.lookup_fail_limit:
                raise HTTPException(429, "TOO_MANY_LOOKUPS")
            purge_codes()
            rec = requests.get(by_code.get(id_or_code, id_or_code))
            if not rec or rec["used"] or rec["exp"] < now:
                fails.append(now)
                raise HTTPException(404, "REQUEST_UNKNOWN")
            return qr_payload(rec)

    @app.post("/present")
    def present(body: PresentIn, background: BackgroundTasks):
        rid = body.requestId
        if not rid:
            try:
                _, payload = decode_jwt_unverified(body.vpJwt)
                rid = find_request_by_nonce(str(payload.get("nonce", "")))
            except Exception:  # noqa: BLE001
                rid = None
        if not rid:
            raise HTTPException(404, "REQUEST_UNKNOWN")
        return run_present(rid, body.vpJwt, background)

    @app.get("/results/{result_id}")
    def get_result(result_id: str, x_counter_token: str | None = Header(None), x_vp_hash: str | None = Header(None)):
        """창구 화면(X-Counter-Token) 또는 그 VP 를 낸 지갑(X-Vp-Hash)만 결과를 본다 (F03)."""
        base = result_id.split("#", 1)[0]
        req = requests.get(base)
        if not req or (result_id != base and result_id not in results):
            raise HTTPException(404, "REQUEST_UNKNOWN")
        if not x_counter_token and not x_vp_hash:
            raise HTTPException(401, "RESULT_AUTH_REQUIRED")
        if x_counter_token:
            if not hmac.compare_digest(x_counter_token.encode(), req["counterToken"].encode()):
                raise HTTPException(403, "RESULT_FORBIDDEN")
            r = results.get(result_id)
            if not r:
                return {"requestId": base, "status": "pending", "exp": req["exp"]}
            return {**serve(r), "status": "done"}
        # 지갑: 자기 VP 해시와 같은 결과를 찾는다 — 거절돼 'rid#…' 에 저장된 자기 제출도 찾아 준다
        want = x_vp_hash.lower()
        # 공격 시연 기록('#attack-')은 지갑 조회 경로로 내보내지 않는다
        keys = [k for k in ([result_id] if result_id != base else [base] + [k for k in list(results) if k.startswith(base + "#")])
                if "#attack-" not in k]
        for k in keys:
            r = results.get(k)
            if r and hmac.compare_digest(str(r["receipt"]["object"]["vpHash"]).lower().encode(), want.encode()):
                return {**serve(r), "status": "done"}
        if result_id in results:
            raise HTTPException(403, "RESULT_FORBIDDEN")
        return {"requestId": base, "status": "pending"}

    @app.post("/demo/attack")
    def attack(body: AttackIn, background: BackgroundTasks):
        """마지막으로 성공한 제출을 변조해 재제출한다. 공격마다 그 공격 하나의 사유로만 차단되게 만든다 (F29)."""
        vp = last.get("vp")
        if not vp:
            raise HTTPException(409, "NO_PRIOR_SUCCESSFUL_PRESENTATION")
        _, payload = decode_jwt_unverified(vp)
        vcs = payload["vp"]["verifiableCredential"]
        if not vcs:
            raise HTTPException(409, "NO_PRIOR_SUCCESSFUL_PRESENTATION")
        rid = last["requestId"]
        prev = requests[rid]
        if body.kind == "replay":
            return _redact_attack(run_present(rid, vp, background, store_as=f"{rid}#attack-replay-{uuid.uuid4().hex[:6]}"))
        if body.kind == "expired":
            # 원래 요청을 잠깐 '사용 전·만료' 상태로 두고 같은 VP 를 낸 뒤 원래 상태로 되돌린다 (F28).
            # 동시에 들어온 만료 공격이 바뀐 상태를 '원래 상태'로 저장하지 않게 공격 전체를 직렬화한다.
            with attack_lock:
                with lock:
                    saved = (prev["exp"], prev["used"])
                    prev["used"], prev["exp"] = False, int(time.time()) - 1
                try:
                    return _redact_attack(run_present(rid, vp, background,
                                                      store_as=f"{rid}#attack-expired-{uuid.uuid4().hex[:6]}"))
                finally:
                    with lock:
                        prev["exp"], prev["used"] = saved
        # 위조·타인: 직전 PASS 요청과 같은 창구·같은 항목으로 새 요청을 만든다 → 항목 누락 사유가 섞이지 않는다
        rec = new_request(RequestIn(verifierId=prev["verifierId"], purpose="공격 시연",
                                    requested=[RequestedClaim(**r) for r in prev["requested"]]))
        if body.kind == "forged":
            # 남의 증명서를 자기 것으로 고쳐 쓴다(소유자 DID 변경) → 발급기관 서명이 깨진다. VP 는 공격자가 정상 서명.
            vp2 = create_vp(holder_did=attacker.did, holder_private_key=attacker.private_key,
                            verifier_did=rec["verifier"]["did"], nonce=rec["nonce"],
                            vc_jwts=[_resubject(v, attacker.did) for v in vcs])
            return _redact_attack(run_present(rec["requestId"], vp2, background))
        if body.kind == "wrong-holder":
            vp2 = create_vp(holder_did=attacker.did, holder_private_key=attacker.private_key,
                            verifier_did=rec["verifier"]["did"], nonce=rec["nonce"], vc_jwts=vcs)
            return _redact_attack(run_present(rec["requestId"], vp2, background))
        raise HTTPException(400, "UNKNOWN_ATTACK")

    return app


def _redact_attack(result: dict) -> dict:
    """인증 없는 공격 시연 응답에서 시민 제출을 다시 찾을 수 있는 값(VP 해시·솔트·증명서 번호·상태 인덱스)을 뺀다.
    전체 기록은 창구 토큰으로 GET /results 에서 본다."""
    out = copy.deepcopy(result)
    obj = out.get("receipt", {}).get("object", {})
    for k in ("vpHash", "salt"):
        obj.pop(k, None)
    for c in out.get("credentials", []):
        for k in ("jti", "statusListIndex"):
            c.pop(k, None)
    out.pop("holderDidShort", None)
    return out


def _resubject(vc_jwt: str, holder_did: str) -> str:
    """VC 의 소유자(credentialSubject.id·sub)만 바꾸고 서명은 그대로 둔다 — 위조 공격 시연용."""
    h, p, s = vc_jwt.split(".")
    payload = json.loads(b64url_decode(p))
    payload["credentialSubject"]["id"] = holder_did
    payload["sub"] = holder_did
    return ".".join([h, b64url_encode(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), s])
