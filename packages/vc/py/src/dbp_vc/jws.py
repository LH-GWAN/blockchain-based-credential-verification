"""compact JWS (EdDSA/Ed25519, base64url 패딩 없음)."""

import base64
import json
import re
from dataclasses import dataclass
from typing import Any

from .ed25519 import ed25519_sign, ed25519_verify
from .errors import VcError


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(bytes(data)).rstrip(b"=").decode("ascii")


_B64URL_ALPHABET = re.compile(r"[A-Za-z0-9_-]*")


def b64url_decode(text: str) -> bytes:
    """엄격한 base64url(패딩 없음) 디코딩. TS(@scure/base)와 같은 입력만 받는다 (F68).
    마지막 글자의 남는 비트가 0이 아닌 변형(같은 바이트로 디코딩되는 16가지 서명 문자열 등)은
    다시 인코딩한 값이 입력과 달라지므로 거부한다."""
    # altchars 변환은 검증보다 먼저 일어나므로 '+', '/' 가 통과한다 — 알파벳을 직접 검사한다.
    # fullmatch: `$` 는 끝 개행 앞에서도 일치한다.
    if not isinstance(text, str) or not _B64URL_ALPHABET.fullmatch(text):
        raise ValueError("not base64url")
    pad = "=" * (-len(text) % 4)
    data = base64.b64decode(text + pad, altchars=b"-_", validate=True)
    if b64url_encode(data) != text:
        raise ValueError("non-canonical base64url")
    return data


def _reject_constant(name: str) -> Any:
    # json.loads 는 기본으로 NaN·Infinity 를 받지만 JSON.parse(TS)는 거부한다.
    raise ValueError(f"non-standard JSON constant: {name}")


def _json_compact(obj: Any) -> str:
    # TS `JSON.stringify` 와 같은 결과 (삽입 순서 유지, 공백 없음, non-ASCII 그대로)
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _encode_json(obj: Any) -> str:
    return b64url_encode(_json_compact(obj).encode("utf-8"))


def _decode_json(segment: str) -> Any:
    try:
        return json.loads(b64url_decode(segment).decode("utf-8"), parse_constant=_reject_constant)
    except (ValueError, UnicodeDecodeError) as e:
        raise VcError("MALFORMED", "JWS segment is not base64url JSON") from e


@dataclass(frozen=True)
class DecodedJws:
    header: dict[str, Any]
    payload: dict[str, Any]
    signature: bytes
    signing_input: str  # `base64url(header).base64url(payload)`


def sign_jws(header: dict[str, Any], payload: Any, private_key: bytes) -> str:
    """compact JWS 생성. 서명은 결정론적이다."""
    if header.get("alg") != "EdDSA":
        raise VcError("MALFORMED", "only alg=EdDSA is supported")
    signing_input = f"{_encode_json(header)}.{_encode_json(payload)}"
    signature = ed25519_sign(signing_input.encode("ascii"), private_key)
    return f"{signing_input}.{b64url_encode(signature)}"


def decode_jws(jws: str) -> DecodedJws:
    """검증 없이 분해만 한다. 구조가 깨지면 MALFORMED."""
    if not isinstance(jws, str):
        raise VcError("MALFORMED", "JWS must be a string")
    parts = jws.split(".")
    if len(parts) != 3:
        raise VcError("MALFORMED", "compact JWS must have 3 segments")
    h, p, s = parts
    header = _decode_json(h)
    payload = _decode_json(p)
    if not isinstance(header, dict):
        raise VcError("MALFORMED", "JWS header must be an object")
    if not isinstance(payload, dict):
        raise VcError("MALFORMED", "JWS payload must be an object")
    try:
        signature = b64url_decode(s)
    except ValueError as e:
        raise VcError("MALFORMED", "JWS signature is not base64url") from e
    return DecodedJws(header=header, payload=payload, signature=signature, signing_input=f"{h}.{p}")


def verify_jws(jws: str, public_key: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
    """서명 검증. 실패 시 VcError(SIG_INVALID), 성공 시 (header, payload)."""
    d = decode_jws(jws)
    if d.header.get("alg") != "EdDSA":
        raise VcError("SIG_INVALID", f"unsupported alg: {d.header.get('alg')!r}")
    if not ed25519_verify(d.signature, d.signing_input.encode("ascii"), public_key):
        raise VcError("SIG_INVALID", "JWS signature verification failed")
    return d.header, d.payload
