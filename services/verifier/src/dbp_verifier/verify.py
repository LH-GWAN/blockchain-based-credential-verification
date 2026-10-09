"""검증 절차 (프롬프트 §9). 각 단계 소요시간(ms)을 기록한다. 발급기관 서버에는 절대 접속하지 않는다.

순서: 형식 → VP 서명 → aud → 1회용 확인번호(nonce) 소모 → 증명서별 원장 대조 → 요청 항목 대조.
서명과 aud 가 맞는 제출만 nonce 를 소모한다 (F08) — 남의 코드로 쓰레기를 먼저 내도 시민의 요청은 그대로 남는다.
"""
from __future__ import annotations

import base64
import json
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Protocol

from dbp_vc import VcError, decode_status_list, decode_vc, get_status, sha256_hex, verify_vc, verify_vp

try:
    from dbp_ledger import LedgerUnavailable
except ImportError:  # 원장 클라이언트가 이 예외를 내보내기 전 버전이어도 검증기는 뜬다
    class LedgerUnavailable(Exception):  # type: ignore[no-redef]
        """원장 연결 실패·시간 초과 (컨트랙트 revert 와 구분)."""

# 결과의 checks 는 항상 이 11개 키를 가진다 (화면 체크리스트와 1:1).
CHECK_KEYS = ("nonce", "vpSignature", "issuerOnLedger", "issuerActive", "issuerAuthoritative", "vcSignature",
              "notExpired", "notRevoked", "ruleVersion", "holderBinding", "requestedClaims")
# 증명서별 checks → 상위 checks
_VC_CHECKS = {"issuerOnLedger": "issuerRegistered", "issuerActive": "issuerActive",
              "issuerAuthoritative": "issuerAuthoritative", "vcSignature": "signature", "notExpired": "notExpired",
              "notRevoked": "notRevoked", "ruleVersion": "ruleVersion", "holderBinding": "holderBinding"}
MAX_VCS = 32
UNAVAILABLE = object()  # 원장 조회가 연결 실패·시간 초과로 끝남 (없음과 구분)


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
    checks: dict[str, bool] = field(default_factory=lambda: dict.fromkeys(CHECK_KEYS, False))
    nonce_consumed: bool = False  # 이 제출이 요청의 nonce 를 정당하게 소모했는가 (결과 저장 키를 정한다)


def confirm_code(vp_jwt: str) -> str:
    """창구 화면과 지갑이 같이 보여 주는 4자리 확인 숫자 (F39). 지갑도 같은 식으로 계산한다."""
    return str(int(sha256_hex(vp_jwt.encode("utf-8"))[:8], 16) % 10000).zfill(4)


def _b64json(seg: str) -> Any:
    seg += "=" * (-len(seg) % 4)
    return json.loads(base64.urlsafe_b64decode(seg))


def decode_jwt_unverified(jwt: str) -> tuple[dict, dict]:
    """서명 확인 없이 분해. header·payload 가 객체가 아니면 TypeError (F37 — 500 대신 VP_MALFORMED)."""
    if not isinstance(jwt, str):
        raise TypeError("JWT must be a string")
    h, p, _ = jwt.split(".")
    header, payload = _b64json(h), _b64json(p)
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise TypeError("JWT header/payload must be objects")
    return header, payload


class Timer:
    def __init__(self, sink: dict[str, float]):
        self.sink = sink
        self.t0 = time.perf_counter()

    def lap(self, name: str) -> None:
        now = time.perf_counter()
        self.sink[name] = round((now - self.t0) * 1000, 2)
        self.t0 = now


def _result(fut: Future | None, deadline: float) -> Any:
    """원장 조회 결과. 연결 실패·시간 초과 → UNAVAILABLE, 컨트랙트 revert 등 '없음' → None."""
    if fut is None:
        return UNAVAILABLE
    try:
        return fut.result(timeout=max(0.0, deadline - time.monotonic()))
    except (LedgerUnavailable, OSError):  # TimeoutError·requests 연결 오류는 OSError 계열
        return UNAVAILABLE
    except Exception:  # noqa: BLE001 — revert(미등록·미게시) 등은 '없음'
        return None


def _submit(ex: ThreadPoolExecutor, ledger: ReadOnlyLedger | None, method: str, *args: str) -> Future | None:
    return ex.submit(getattr(ledger, method), *args) if ledger is not None else None


def _prepare(vc_jwt: str) -> dict:
    """원장 조회 전에 VC 를 분해하고 항목(claim)을 먼저 꺼낸다 (F33 — 원장 장애여도 무엇이 제출됐는지는 안다)."""
    vc = decode_vc(vc_jwt)["vc"]
    status = vc.get("credentialStatus") or {}
    ev = (vc.get("evidence") or [{}])[0]
    subj = dict(vc["credentialSubject"])
    subject_id = subj.pop("id", None)
    claim, value = (next(iter(subj.items())) if len(subj) == 1 else (None, None))
    return {"vc": vc, "issuer": vc["issuer"], "status": status, "evidence": ev, "subject": subject_id,
            "claim": claim, "value": value}


def _evaluate(vc_jwt: str, p: dict, issuer: Any, sl: Any, onb: Any, *, holder_did: str, issuer_of: dict[str, str],
              accepted: dict[str, list[str]], now: float) -> tuple[dict, list[str]]:
    reasons: list[str] = []
    issuer_did, status, ev, claim = p["issuer"], p["status"], p["evidence"], p["claim"]
    checks: dict[str, bool] = dict.fromkeys(_VC_CHECKS.values(), False)
    info = {"jti": p["vc"].get("id"), "issuerDid": issuer_did,
            "issuerName": issuer["name"] if isinstance(issuer, dict) else None,
            "claim": claim, "value": None, "statusListIndex": status.get("statusListIndex"), "checks": checks}

    # 소관 발급기관 (F11): 번들의 issuerOf 와 VC 발급기관이 같아야 한다. 창구 자체 조회 항목(self)은 VC 로 받지 않는다.
    owner = issuer_of.get(claim or "")
    checks["issuerAuthoritative"] = bool(owner) and owner != "self" and owner == issuer_did
    if not checks["issuerAuthoritative"]:
        reasons.append("ISSUER_NOT_AUTHORITATIVE")

    if issuer is UNAVAILABLE:
        reasons.append("LEDGER_UNAVAILABLE")
        return info, reasons
    if issuer is None:
        reasons.append("ISSUER_UNKNOWN")
        return info, reasons
    checks["issuerRegistered"] = True
    checks["issuerActive"] = bool(issuer["active"])
    if not issuer["active"]:
        reasons.append("ISSUER_INACTIVE")

    res = verify_vc(vc_jwt, issuer["ed25519PubKey"], now=int(now))
    checks["signature"] = bool(res["checks"]["signature"])
    if not checks["signature"]:
        reasons.append("VC_SIG_INVALID")
    checks["notExpired"] = bool(res["checks"]["notExpired"] and res["checks"]["active"])
    if not res["checks"]["notExpired"]:
        reasons.append("EXPIRED")
    if not res["checks"]["active"]:
        reasons.append("NOT_YET_VALID")

    checks["holderBinding"] = bool(holder_did) and p["subject"] == holder_did
    if not checks["holderBinding"]:
        reasons.append("HOLDER_MISMATCH")

    if sl is UNAVAILABLE:
        reasons.append("LEDGER_UNAVAILABLE")
    elif sl is None:
        reasons.append("STATUS_LIST_UNAVAILABLE")
    else:
        # 상태 목록 게시자 = 발급기관 컨트롤러여야 폐기 비트를 믿을 수 있다 (F60)
        sl_owner, controller = str(sl.get("owner") or "").lower(), str(issuer.get("controller") or "").lower()
        if not sl_owner or sl_owner != controller:
            reasons.append("STATUS_LIST_OWNER_MISMATCH")
        else:
            revoked = get_status(bytearray(decode_status_list(sl["encodedList"])), int(status.get("statusListIndex", -1)))
            checks["notRevoked"] = not revoked
            info["statusListVersion"] = sl["version"]
            if revoked:
                reasons.append("REVOKED")

    # 규칙 버전: 창구가 받는 버전인지(F43) → 원장에 등록된 번들 해시와 같은지
    if ev.get("version") not in accepted.get(str(ev.get("bundle")), []):
        reasons.append("RULE_VERSION_NOT_ACCEPTED")
    elif onb is UNAVAILABLE:
        reasons.append("LEDGER_UNAVAILABLE")
    elif onb is None or str(onb["bundleHash"]).lower() != str(ev.get("bundleHash", "")).lower():
        reasons.append("RULE_HASH_MISMATCH")
    else:
        checks["ruleVersion"] = True
        info["ruleVersion"] = f"{ev.get('bundle')}@{ev.get('version')}"

    if not reasons:
        info["value"] = p["value"]  # 모든 확인을 통과한 값만 돌려준다 (F09·F38)
    return info, reasons


def verify_presentation(vp_jwt: str, *, verifier_did: str, requested: list[dict], nonce_lookup, ledger: ReadOnlyLedger | None,
                        issuer_of: dict[str, str] | None = None, accepted_bundles: dict[str, list[str]] | None = None,
                        deadline_s: float = 6.0, now: float | None = None) -> VerifyOutcome:
    """nonce_lookup(nonce) -> ("ok"|"unknown"|"expired"|"used") 이고 "ok" 면 즉시 사용 처리해야 한다.

    issuer_of: 번들 claims.issuerOf (claim → 소관 발급기관 DID). accepted_bundles: {번들: [받는 버전]}.
    deadline_s: 원장 조회 전체 시간 상한 — 넘기면 LEDGER_UNAVAILABLE (F34).
    """
    now = now or time.time()
    issuer_of = issuer_of or {}
    accepted = accepted_bundles if accepted_bundles is not None else {}
    out = VerifyOutcome()
    t = Timer(out.timings_ms)
    t0 = time.perf_counter()

    def finish() -> VerifyOutcome:
        out.reason_codes = list(dict.fromkeys(out.reason_codes))
        out.verdict = "PASS" if not out.reason_codes else "FAIL"
        out.timings_ms["total"] = round((time.perf_counter() - t0) * 1000, 2)
        return out

    # 1) 형식 (F37 — 객체가 아니면 500 이 아니라 VP_MALFORMED)
    try:
        _, payload = decode_jwt_unverified(vp_jwt)
        vp = payload.get("vp")
        vcs = vp.get("verifiableCredential") if isinstance(vp, dict) else None
        if not isinstance(vcs, list) or not all(isinstance(v, str) for v in vcs) or len(vcs) > MAX_VCS:
            raise TypeError("vp.verifiableCredential must be a list of strings")
    except Exception:  # noqa: BLE001 — 어떤 형식 오류든 VP_MALFORMED
        out.reason_codes.append("VP_MALFORMED")
        return finish()
    t.lap("parse")

    # 2) VP 서명 — aud 는 3) 에서 따로 본다 (verify_vp 는 aud 를 먼저 보므로 제출물 자신의 aud 를 넘긴다)
    try:
        out.holder_did = verify_vp(vp_jwt, expected_aud=payload.get("aud"))["holderDid"]
        out.checks["vpSignature"] = True
    except VcError as e:
        out.reason_codes.append({"MALFORMED": "VP_MALFORMED", "NONCE_MISSING": "NONCE_MISSING"}.get(e.code, "VP_SIG_INVALID"))
    except Exception:  # noqa: BLE001
        out.reason_codes.append("VP_MALFORMED")
    t.lap("vpSignature")
    if out.reason_codes:
        return finish()

    # 3) aud → 4) nonce. 서명과 aud 가 맞는 제출만 nonce 를 소모한다. 사용 여부를 만료보다 먼저 본다 (F28).
    if payload.get("aud") != verifier_did:
        out.reason_codes.append("AUD_MISMATCH")
        return finish()
    st = nonce_lookup(payload["nonce"])
    if st != "ok":
        out.reason_codes.append({"unknown": "NONCE_UNKNOWN", "expired": "NONCE_EXPIRED", "used": "NONCE_REUSED"}[st])
        t.lap("nonce")
        return finish()
    out.checks["nonce"] = out.nonce_consumed = True
    t.lap("nonce")

    wanted = {r["claim"] for r in requested}
    prepared: list[tuple[str, dict]] = []
    for vc_jwt in vcs:
        try:
            p = _prepare(vc_jwt)
        except Exception:  # noqa: BLE001 — 분해하지 못한 VC 는 위조로 본다
            out.credentials.append({"error": "VC_MALFORMED", "claim": None, "value": None, "checks": {}})
            out.reason_codes.append("VC_SIG_INVALID")
            continue
        if p["claim"] not in wanted:
            # 요청하지 않은 증명서는 원장에 묻지도, 결과에 남기지도 않는다 (F36)
            out.reason_codes.append("UNREQUESTED_CREDENTIAL")
            continue
        prepared.append((vc_jwt, p))

    deadline = time.monotonic() + deadline_s
    ex = ThreadPoolExecutor(max_workers=max(1, min(12, 3 * len(prepared))))
    try:
        futs = [(_submit(ex, ledger, "get_issuer", p["issuer"]),
                 _submit(ex, ledger, "get_status_list", str(p["status"].get("statusListCredential", ""))),
                 _submit(ex, ledger, "get_bundle", str(p["evidence"].get("bundle", "")), str(p["evidence"].get("version", ""))))
                for _, p in prepared]
        for (vc_jwt, p), (f_iss, f_sl, f_b) in zip(prepared, futs):
            issuer, sl, onb = _result(f_iss, deadline), _result(f_sl, deadline), _result(f_b, deadline)
            try:
                info, reasons = _evaluate(vc_jwt, p, issuer, sl, onb, holder_did=out.holder_did or "",
                                          issuer_of=issuer_of, accepted=accepted, now=now)
            except Exception:  # noqa: BLE001
                info, reasons = {"error": "VC_MALFORMED", "claim": p["claim"], "value": None, "checks": {}}, ["VC_SIG_INVALID"]
            out.credentials.append(info)
            out.reason_codes.extend(reasons)
            if not reasons:
                out.claims[p["claim"]] = bool(p["value"])
                out.issuers[p["claim"]] = info.get("issuerName") or info.get("issuerDid")
    finally:
        ex.shutdown(wait=False, cancel_futures=True)  # 멈춘 원장 조회를 기다리지 않는다
    t.lap("credentials")

    presented = {c.get("claim") for c in out.credentials if c.get("claim")}  # 제출됐지만 검증 실패한 항목 포함
    if not requested:
        out.reason_codes.append("REQUESTED_INVALID")
    for req in requested:
        c, exp = req["claim"], bool(req.get("expected", True))
        if c not in presented:
            out.reason_codes.append("CLAIM_MISSING")
        elif c in out.claims and out.claims[c] != exp:
            out.reason_codes.append("CLAIM_FALSE")
    t.lap("claims")

    creds = out.credentials
    for top, per_vc in _VC_CHECKS.items():
        out.checks[top] = bool(creds) and all(c.get("checks", {}).get(per_vc) for c in creds)
    out.checks["requestedClaims"] = bool(requested) and "UNREQUESTED_CREDENTIAL" not in out.reason_codes and all(
        out.claims.get(r["claim"]) == bool(r.get("expected", True)) for r in requested)
    return finish()
