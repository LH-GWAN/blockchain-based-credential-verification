"""검증 절차 (프롬프트 §9). 각 단계 소요시간(ms)을 기록한다. 발급기관 서버에는 절대 접속하지 않는다."""
from __future__ import annotations

import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Protocol

from dbp_vc import decode_status_list, decode_vc, get_status, verify_vc, verify_vp


class ReadOnlyLedger(Protocol):
    def get_issuer(self, did: str) -> dict: ...
    def get_bundle(self, bundle: str, version: str) -> dict: ...
    def get_status_list(self, list_id: str) -> dict: ...


@dataclass
class VerifyOutcome:
    verdict: str = "FAIL"
    reason_codes: list[str] = field(default_factory=list)
    holder_did: str | None = None
    claims: dict[str, bool] = field(default_factory=dict)
    issuers: dict[str, str] = field(default_factory=dict)  # claim -> issuer name
    credentials: list[dict] = field(default_factory=list)
    timings_ms: dict[str, float] = field(default_factory=dict)
    checks: dict[str, bool] = field(default_factory=dict)


def _b64json(seg: str) -> dict:
    seg += "=" * (-len(seg) % 4)
    return json.loads(base64.urlsafe_b64decode(seg))


def decode_jwt_unverified(jwt: str) -> tuple[dict, dict]:
    h, p, _ = jwt.split(".")
    return _b64json(h), _b64json(p)


class Timer:
    def __init__(self, sink: dict[str, float]):
        self.sink = sink
        self.t0 = time.perf_counter()

    def lap(self, name: str) -> None:
        now = time.perf_counter()
        self.sink[name] = round((now - self.t0) * 1000, 2)
        self.t0 = now


def _check_one_vc(vc_jwt: str, holder_did: str, ledger: ReadOnlyLedger, now: float) -> tuple[dict, list[str]]:
    reasons: list[str] = []
    vc = decode_vc(vc_jwt)
    issuer_did = vc["issuer"]
    status = vc.get("credentialStatus", {})
    ev = (vc.get("evidence") or [{}])[0]
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_iss = ex.submit(ledger.get_issuer, issuer_did)
        f_sl = ex.submit(ledger.get_status_list, status.get("statusListCredential", ""))
        f_b = ex.submit(ledger.get_bundle, ev.get("bundle", ""), ev.get("version", ""))
        try:
            issuer = f_iss.result()
        except Exception:
            issuer = None
        try:
            sl = f_sl.result()
        except Exception:
            sl = None
        try:
            onb = f_b.result()
        except Exception:
            onb = None

    info = {"jti": vc.get("id"), "issuerDid": issuer_did, "issuerName": issuer["name"] if issuer else None,
            "claim": None, "value": None, "statusListIndex": status.get("statusListIndex"), "checks": {}}
    if issuer is None:
        reasons.append("ISSUER_UNKNOWN")
        info["checks"]["issuerRegistered"] = False
        return info, reasons
    info["checks"]["issuerRegistered"] = True
    info["checks"]["issuerActive"] = bool(issuer["active"])
    if not issuer["active"]:
        reasons.append("ISSUER_INACTIVE")

    res = verify_vc(vc_jwt, issuer["ed25519PubKey"], now=int(now))
    info["checks"]["signature"] = bool(res["checks"]["signature"])
    if not res["checks"]["signature"]:
        reasons.append("VC_SIG_INVALID")
    if not res["checks"]["notExpired"]:
        reasons.append("EXPIRED")
    if not res["checks"]["active"]:
        reasons.append("NOT_YET_VALID")

    subj = dict(vc["credentialSubject"])
    subject_id = subj.pop("id", None)
    info["checks"]["holderBinding"] = subject_id == holder_did
    if subject_id != holder_did:
        reasons.append("HOLDER_MISMATCH")
    if len(subj) == 1:
        (info["claim"], info["value"]), = subj.items()

    if sl is None:
        reasons.append("STATUS_LIST_UNAVAILABLE")
        info["checks"]["notRevoked"] = False
    else:
        revoked = get_status(bytearray(decode_status_list(sl["encodedList"])), int(status.get("statusListIndex", -1)))
        info["checks"]["notRevoked"] = not revoked
        info["statusListVersion"] = sl["version"]
        if revoked:
            reasons.append("REVOKED")

    if onb is None or onb["bundleHash"].lower() != str(ev.get("bundleHash", "")).lower():
        reasons.append("RULE_HASH_MISMATCH")
        info["checks"]["ruleVersion"] = False
    else:
        info["checks"]["ruleVersion"] = True
        info["ruleVersion"] = f"{ev.get('bundle')}@{ev.get('version')}"
    return info, reasons


def verify_presentation(vp_jwt: str, *, verifier_did: str, requested: list[dict], nonce_lookup, ledger: ReadOnlyLedger,
                        now: float | None = None) -> VerifyOutcome:
    """nonce_lookup(nonce) -> ("ok"|"unknown"|"expired"|"used") 이고 "ok" 면 즉시 사용 처리해야 한다."""
    now = now or time.time()
    out = VerifyOutcome()
    t = Timer(out.timings_ms)
    t0 = time.perf_counter()
    try:
        _, payload = decode_jwt_unverified(vp_jwt)
    except Exception:
        out.reason_codes.append("VP_MALFORMED")
        out.timings_ms["total"] = round((time.perf_counter() - t0) * 1000, 2)
        return out
    t.lap("parse")

    if payload.get("aud") != verifier_did:
        out.reason_codes.append("AUD_MISMATCH")
    nonce = payload.get("nonce")
    if not nonce:
        out.reason_codes.append("NONCE_MISSING")
    else:
        st = nonce_lookup(nonce)
        if st != "ok":
            out.reason_codes.append({"unknown": "NONCE_UNKNOWN", "expired": "NONCE_EXPIRED", "used": "NONCE_REUSED"}[st])
    out.checks["nonce"] = not any(r.startswith("NONCE") or r == "AUD_MISMATCH" for r in out.reason_codes)
    t.lap("nonce")

    try:
        vp = verify_vp(vp_jwt, expected_aud=verifier_did)
        out.holder_did = vp["holderDid"]
        out.checks["vpSignature"] = True
    except Exception:
        out.reason_codes.append("VP_SIG_INVALID")
        out.checks["vpSignature"] = False
        out.holder_did = payload.get("iss")
    t.lap("vpSignature")

    vcs = (payload.get("vp") or {}).get("verifiableCredential") or []
    for vc_jwt in vcs:
        try:
            info, reasons = _check_one_vc(vc_jwt, out.holder_did or "", ledger, now)
        except Exception:
            info, reasons = {"error": "VC_MALFORMED"}, ["VC_SIG_INVALID"]
        out.credentials.append(info)
        out.reason_codes.extend(reasons)
        if info.get("claim") is not None and not reasons:
            out.claims[info["claim"]] = bool(info["value"])
            out.issuers[info["claim"]] = info.get("issuerName") or info.get("issuerDid")
    t.lap("credentials")

    for req in requested:
        c, exp = req["claim"], bool(req.get("expected", True))
        if c not in out.claims:
            out.reason_codes.append("CLAIM_MISSING")
        elif out.claims[c] != exp:
            out.reason_codes.append("CLAIM_FALSE")
    t.lap("claims")

    out.reason_codes = list(dict.fromkeys(out.reason_codes))
    out.verdict = "PASS" if not out.reason_codes else "FAIL"
    out.checks.update({
        "issuerOnLedger": all(c.get("checks", {}).get("issuerRegistered") for c in out.credentials) and bool(out.credentials),
        "vcSignature": all(c.get("checks", {}).get("signature") for c in out.credentials) and bool(out.credentials),
        "notRevoked": all(c.get("checks", {}).get("notRevoked") for c in out.credentials) and bool(out.credentials),
        "ruleVersion": all(c.get("checks", {}).get("ruleVersion") for c in out.credentials) and bool(out.credentials),
        "holderBinding": all(c.get("checks", {}).get("holderBinding") for c in out.credentials) and bool(out.credentials),
        "requestedClaims": not any(r in ("CLAIM_MISSING", "CLAIM_FALSE") for r in out.reason_codes),
    })
    out.timings_ms["total"] = round((time.perf_counter() - t0) * 1000, 2)
    return out
