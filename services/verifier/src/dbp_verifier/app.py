from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
import uuid
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from dbp_rules import evaluate_policy_partial, load_bundle, rule_vars
from dbp_vc import create_vp, generate_holder_key, random_salt, receipt_hash, sha256_hex

from .comparison import build_comparison, precomputed
from .config import PRESETS, REASON_KO, VERIFIERS, Settings
from .verify import decode_jwt_unverified, verify_presentation

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
    vpJwt: str


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
    except Exception as e:
        log.warning("ledger client unavailable: %s", e)
        return None


def create_app(settings: Settings | None = None, ledger=None) -> FastAPI:
    settings = settings or Settings()
    ledger = ledger if ledger is not None else build_ledger(settings)
    bundle = load_bundle()
    labels = bundle["claims"]["labels"]
    app = FastAPI(title="대구 혜택패스 검증기관", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    requests: dict[str, dict] = {}
    by_code: dict[str, str] = {}
    results: dict[str, dict] = {}
    last: dict[str, object] = {}  # lastVp, lastRequestId
    lock = threading.Lock()
    attacker = generate_holder_key(bytes([0xAA]) * 32)  # 시연용 공격자 키

    def nonce_lookup_factory(request_id: str):
        def lookup(nonce: str) -> str:
            with lock:
                req = requests.get(request_id)
                if not req or req["nonce"] != nonce:
                    return "unknown"
                if req["exp"] < time.time():
                    return "expired"
                if req["used"]:
                    return "used"
                req["used"] = True
                return "ok"
        return lookup

    def find_request_by_nonce(nonce: str) -> str | None:
        for rid, r in requests.items():
            if r["nonce"] == nonce:
                return rid
        return None

    def anchor_receipt(request_id: str, h: str) -> None:
        if not ledger:
            return
        try:
            tx = ledger.anchor_receipt(h, KIND_PRESENTATION)
            results[request_id]["receipt"]["txHash"] = tx
        except Exception as e:
            log.warning("receipt anchor failed: %s", e)
            results[request_id]["receipt"]["txHash"] = None
            results[request_id]["receipt"]["error"] = str(e)

    def run_present(request_id: str, vp_jwt: str, background: BackgroundTasks | None, store_as: str | None = None) -> dict:
        """store_as 가 주어지면 결과를 그 키로 저장한다 (공격 시연이 원래 요청의 결과를 덮어쓰지 않도록)."""
        req = requests.get(request_id)
        if not req:
            raise HTTPException(404, "REQUEST_UNKNOWN")
        vdid = req["verifier"]["did"]
        out = verify_presentation(vp_jwt, verifier_did=vdid, requested=req["requested"],
                                  nonce_lookup=nonce_lookup_factory(request_id), ledger=ledger)
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
            "checks": out.checks, "timingsMs": out.timings_ms, "holderDidShort": (out.holder_did or "")[:24] + "…",
            "receipt": {"hash": h, "object": receipt_obj, "txHash": None},
            "verifiedAt": int(time.time()),
        }
        # 조회형 대비 비교 (§12.5): 이번 요청 항목으로 계산 — 숫자를 화면에 하드코딩하지 않는다
        result["comparison"] = build_comparison(req["requested"], labels, req.get("presetId"))
        if req.get("policyId"):
            # 제출된 항목 + 창구가 자체 조회한 항목(프리셋 counterChecked)만으로 판정한다.
            # 제출되지 않은 항목을 거짓으로 채우지 않으므로, 결과가 그 항목에 달려 있으면 eligible=None.
            preset = next((p for p in PRESETS if p["id"] == req.get("presetId")), None)
            used = rule_vars(bundle["policies"]["rules"].get(req["policyId"], {}))
            counter = {c["claim"]: c["expected"] for c in (preset or {}).get("counterChecked", [])
                       if preset["policyId"] == req["policyId"] and c["claim"] in used}
            pc = evaluate_policy_partial(bundle, req["policyId"], {**counter, **out.claims})
            issuer_of = bundle["claims"]["issuerOf"]
            result["policyCheck"] = {
                "policyId": req["policyId"], "eligible": pc["eligible"],
                "pending": [{"claim": c, "label": labels.get(c, c), "counterCheck": issuer_of.get(c) == "self"}
                            for c in pc["pending"]],
                "counterChecked": [{"claim": c, "expected": v, "label": labels.get(c, c)} for c, v in counter.items()],
            }
        key = store_as or request_id
        result["resultId"] = key
        results[key] = result
        if out.verdict == "PASS" and store_as is None:
            last["vp"] = vp_jwt
            last["requestId"] = request_id
        if background is not None:
            background.add_task(anchor_receipt, key, h)
        else:
            anchor_receipt(key, h)
        return result

    def new_request(body: RequestIn) -> dict:
        v = VERIFIERS.get(body.verifierId or settings.default_verifier)
        if not v:
            raise HTTPException(400, "VERIFIER_UNKNOWN")
        # 창구 종류가 취급하지 않는 상품 프리셋(예: 저축은행의 새희망홀씨)은 받지 않는다. policyId 만 보내도 같다.
        offered = [p for p in PRESETS if (body.presetId and p["id"] == body.presetId)
                   or (not body.presetId and body.policyId and p["policyId"] == body.policyId)]
        if offered and all(v["kind"] not in p.get("verifierKinds", [v["kind"]]) for p in offered):
            raise HTTPException(400, "PRESET_NOT_OFFERED")
        if body.policyId and body.policyId not in bundle["policies"]["rules"]:
            raise HTTPException(400, "POLICY_UNKNOWN")  # nonce 를 쓰기 전에 거른다
        rid = "r_" + uuid.uuid4().hex[:12]
        code = f"{secrets.randbelow(900000) + 100000}"
        nonce = "n_" + secrets.token_hex(32)
        exp = int(time.time()) + settings.request_ttl_s
        rec = {"requestId": rid, "shortCode": code, "verifier": v, "purpose": body.purpose,
               "requested": [r.model_dump() for r in body.requested], "policyId": body.policyId, "presetId": body.presetId,
               "nonce": nonce, "exp": exp, "used": False, "createdAt": int(time.time())}
        with lock:
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
        return {"ok": True, "ledgerConnected": bool(ledger and getattr(ledger, "is_connected", lambda: True)())}

    @app.get("/verifiers")
    def verifiers():
        return [{"id": k, **v} for k, v in VERIFIERS.items()]

    @app.get("/claims")
    def claims():
        # 창구가 요청할 수 있는 항목 = VC 로 발급되는 사실만 (issuerOf == "self" 제외)
        issuer_of = bundle["claims"]["issuerOf"]
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
        return {**p, "qrText": json.dumps(p, ensure_ascii=False, separators=(",", ":"))}

    @app.get("/requests/{id_or_code}")
    def get_request(id_or_code: str):
        rid = by_code.get(id_or_code, id_or_code)
        rec = requests.get(rid)
        if not rec:
            raise HTTPException(404, "REQUEST_UNKNOWN")
        return qr_payload(rec)

    @app.post("/present")
    def present(body: PresentIn, background: BackgroundTasks):
        rid = body.requestId
        if not rid:
            try:
                _, payload = decode_jwt_unverified(body.vpJwt)
                rid = find_request_by_nonce(payload.get("nonce", ""))
            except Exception:
                rid = None
        if not rid:
            raise HTTPException(404, "REQUEST_UNKNOWN")
        # 같은 요청에 대한 두 번째 제출(재사용 시도)은 원래 결과를 덮어쓰지 않고 별도 키로 기록한다
        store_as = f"{rid}#replay-{uuid.uuid4().hex[:6]}" if rid in results else None
        return run_present(rid, body.vpJwt, background, store_as=store_as)

    @app.get("/results/{request_id}")
    def get_result(request_id: str):
        r = results.get(request_id)
        if not r:
            if request_id in requests:
                return {"requestId": request_id, "status": "pending", "exp": requests[request_id]["exp"]}
            raise HTTPException(404, "REQUEST_UNKNOWN")
        return {**r, "status": "done"}

    @app.post("/demo/attack")
    def attack(body: AttackIn):
        """마지막으로 성공한 제출을 변조해 재제출한다. 각 공격이 어떤 사유로 차단되는지 시연."""
        vp = last.get("vp")
        if not vp:
            raise HTTPException(409, "NO_PRIOR_SUCCESSFUL_PRESENTATION")
        _, payload = decode_jwt_unverified(vp)
        vcs = payload["vp"]["verifiableCredential"]
        if body.kind == "replay":
            rid = last["requestId"]
            return run_present(rid, vp, None, store_as=f"{rid}#attack-replay-{uuid.uuid4().hex[:6]}")
        if body.kind == "expired":
            rid = last["requestId"]
            with lock:
                requests[rid]["used"] = False
                requests[rid]["exp"] = int(time.time()) - 1
            return run_present(rid, vp, None, store_as=f"{rid}#attack-expired-{uuid.uuid4().hex[:6]}")
        rec = new_request(RequestIn(verifierId=None, purpose="공격 시연"))
        if body.kind == "forged":
            h, p, s = vcs[0].split(".")
            s = s[:-2] + ("AA" if s[-2:] != "AA" else "BB")
            tampered = [".".join([h, p, s]), *vcs[1:]]
            vp2 = create_vp(holder_did=attacker.did, holder_private_key=attacker.private_key,
                            verifier_did=rec["verifier"]["did"], nonce=rec["nonce"], vc_jwts=tampered)
            return run_present(rec["requestId"], vp2, None)
        if body.kind == "wrong-holder":
            vp2 = create_vp(holder_did=attacker.did, holder_private_key=attacker.private_key,
                            verifier_did=rec["verifier"]["did"], nonce=rec["nonce"], vc_jwts=vcs)
            return run_present(rec["requestId"], vp2, None)
        raise HTTPException(400, "UNKNOWN_ATTACK")

    return app
