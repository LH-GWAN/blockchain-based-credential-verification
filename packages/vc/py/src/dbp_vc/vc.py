"""§6.5 원자적 자격증명 (VC-JWT) 발급·분해·검증. 반환 dict의 키는 TS와 동일한 camelCase."""

from datetime import datetime
from typing import Any

from .errors import VcError
from .jws import decode_jws, sign_jws, verify_jws
from .timeutil import iso_to_seconds, to_seconds

VC_CONTEXT = "https://www.w3.org/ns/credentials/v2"
VC_TYPE = ["VerifiableCredential", "DaeguEligibilityCredential"]
VC_SCHEMA = {"id": "dbp:schema:atomic-claim:1", "type": "JsonSchema"}
VC_JWT_TYP = "vc+jwt"

_REGISTERED_CLAIMS = ("iss", "sub", "nbf", "exp", "jti")


def issue_vc(
    *,
    id: str,
    issuer_did: str,
    issuer_kid: str,
    issuer_private_key: bytes,
    holder_did: str,
    claim: dict[str, Any],
    valid_from: str,
    valid_until: str,
    status: dict[str, Any],
    evidence: dict[str, Any],
) -> str:
    """VC-JWT 발급. header `{alg: EdDSA, typ: vc+jwt, kid}`. 결정론적(같은 입력 → 같은 JWT).

    claim = {"name": str, "value": bool}, status = {"listId": str, "index": int},
    evidence = {"bundle": str, "version": str, "bundleHash": str}  (TS와 같은 키)
    """
    name, value = claim.get("name"), claim.get("value")
    if not isinstance(name, str) or not name or name == "id":
        raise VcError("MALFORMED", 'claim.name must be a non-empty string other than "id"')
    if not isinstance(value, bool):
        raise VcError("MALFORMED", "claim.value must be boolean (atomic VC)")
    index = status.get("index")
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise VcError("MALFORMED", "status.index must be a non-negative integer")
    nbf = iso_to_seconds(valid_from)
    exp = iso_to_seconds(valid_until)
    if exp <= nbf:
        raise VcError("MALFORMED", "validUntil must be after validFrom")

    payload: dict[str, Any] = {
        "@context": [VC_CONTEXT],
        "id": id,
        "type": list(VC_TYPE),
        "issuer": issuer_did,
        "validFrom": valid_from,
        "validUntil": valid_until,
        "credentialSubject": {"id": holder_did, name: value},
        "credentialSchema": dict(VC_SCHEMA),
        "credentialStatus": {
            "type": "BitstringStatusListEntry",
            "statusPurpose": "revocation",
            "statusListIndex": str(index),
            "statusListCredential": status["listId"],
        },
        "evidence": [
            {
                "type": "RuleEvaluation",
                "bundle": evidence["bundle"],
                "version": evidence["version"],
                "bundleHash": evidence["bundleHash"],
            }
        ],
        "iss": issuer_did,
        "sub": holder_did,
        "nbf": nbf,
        "exp": exp,
        "jti": id,
    }
    header = {"alg": "EdDSA", "typ": VC_JWT_TYP, "kid": issuer_kid}
    return sign_jws(header, payload, issuer_private_key)


def _strip_registered_claims(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in payload.items() if k not in _REGISTERED_CLAIMS}


def decode_vc(jwt: str) -> dict[str, Any]:
    """서명 검증 없이 분해 → {"header", "payload", "vc"}."""
    d = decode_jws(jwt)
    return {"header": d.header, "payload": d.payload, "vc": _strip_registered_claims(d.payload)}


def verify_vc(jwt: str, issuer_public_key: bytes, now: datetime | int | None = None) -> dict[str, Any]:
    """VC-JWT 검증 → {"vc", "payload", "checks": {"signature", "notExpired", "active"}}.

    signature: 서명이 issuer_public_key로 검증되고 typ이 vc+jwt (False → VC_SIG_INVALID)
    notExpired: now < exp (False → EXPIRED)
    active: nbf <= now, 즉 validFrom 도래 (False → NOT_YET_VALID)
    원장 조회(발급기관 활성, 폐기 비트, 번들 해시)는 호출자(verifier 서비스) 책임.
    """
    decoded = decode_vc(jwt)
    header, payload = decoded["header"], decoded["payload"]
    try:
        verify_jws(jwt, issuer_public_key)
        signature = header.get("typ") == VC_JWT_TYP
    except VcError:
        signature = False
    now_sec = to_seconds(now)
    exp, nbf = payload.get("exp"), payload.get("nbf")
    not_expired = isinstance(exp, int) and not isinstance(exp, bool) and now_sec < exp
    active = isinstance(nbf, int) and not isinstance(nbf, bool) and nbf <= now_sec
    return {
        "vc": decoded["vc"],
        "payload": payload,
        "checks": {"signature": signature, "notExpired": not_expired, "active": active},
    }
