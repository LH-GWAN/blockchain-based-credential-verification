"""§6.6 제출(VP-JWT) 생성·검증."""

from typing import Any

from .didkey import did_key_to_public_key
from .errors import VcError
from .jws import decode_jws, sign_jws, verify_jws
from .timeutil import to_seconds
from .vc import VC_CONTEXT

VP_JWT_TYP = "vp+jwt"


def create_vp(
    *,
    holder_did: str,
    holder_private_key: bytes,
    verifier_did: str,
    nonce: str,
    vc_jwts: list[str],
    iat: int | None = None,
) -> str:
    """VP-JWT 생성. header `{alg: EdDSA, typ: vp+jwt}`. 요청된 claim의 VC만 담는다."""
    if not isinstance(nonce, str) or not nonce:
        raise VcError("MALFORMED", "nonce required")
    if not isinstance(vc_jwts, list) or any(not isinstance(v, str) for v in vc_jwts):
        raise VcError("MALFORMED", "vc_jwts must be list[str]")
    iat_sec = to_seconds(None) if iat is None else iat
    if isinstance(iat_sec, bool) or not isinstance(iat_sec, int):
        raise VcError("MALFORMED", "iat must be an integer (seconds)")
    payload = {
        "iss": holder_did,
        "aud": verifier_did,
        "nonce": nonce,
        "iat": iat_sec,
        "vp": {
            "@context": [VC_CONTEXT],
            "type": ["VerifiablePresentation"],
            "verifiableCredential": list(vc_jwts),
        },
    }
    return sign_jws({"alg": "EdDSA", "typ": VP_JWT_TYP}, payload, holder_private_key)


def verify_vp(jwt: str, expected_aud: str) -> dict[str, Any]:
    """VP-JWT 검증 (§9 1~3단계): 파싱 → aud → nonce 존재 → iss(did:key) 공개키 → 서명.

    실패 시 VcError(code = AUD_MISMATCH | NONCE_MISSING | VP_SIG_INVALID | MALFORMED).
    성공 시 {"payload", "holderDid"}. nonce 단일 사용 검사는 호출자 책임.
    """
    d = decode_jws(jwt)
    header, payload = d.header, d.payload
    if header.get("typ") != VP_JWT_TYP:
        raise VcError("MALFORMED", f"typ must be {VP_JWT_TYP}")
    if payload.get("aud") != expected_aud:
        raise VcError("AUD_MISMATCH", "VP aud does not match verifier DID")
    nonce = payload.get("nonce")
    if not isinstance(nonce, str) or not nonce:
        raise VcError("NONCE_MISSING", "VP nonce missing")
    iss = payload.get("iss")
    if not isinstance(iss, str):
        raise VcError("MALFORMED", "VP iss missing")
    vp = payload.get("vp")
    if not isinstance(vp, dict) or not isinstance(vp.get("verifiableCredential"), list):
        raise VcError("MALFORMED", "vp.verifiableCredential missing")
    try:
        public_key = did_key_to_public_key(iss)
    except VcError as e:
        raise VcError("VP_SIG_INVALID", f"cannot resolve holder key from {iss}") from e
    try:
        verify_jws(jwt, public_key)
    except VcError as e:
        raise VcError("VP_SIG_INVALID", str(e)) from e
    return {"payload": payload, "holderDid": iss}
