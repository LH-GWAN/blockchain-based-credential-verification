"""§6.8 영수증 해시·salt·nonce."""

import secrets
from typing import Any

from .jcs import canonicalize, sha256_hex


def receipt_hash(obj: dict[str, Any]) -> str:
    """'0x' + SHA-256(JCS(obj)). ReceiptAnchor.anchor(bytes32) 입력.

    consent: {kind:"consent", holderDid, issuerDid, claims, ts, salt}
    presentation: {kind:"presentation", vpHash, verifierDid, nonce, ts, salt}
    """
    return "0x" + sha256_hex(canonicalize(obj))


def random_salt() -> str:
    """32바이트 난수 salt, hex 64자 (0x 없음). 원문+salt는 지갑만 보관."""
    return secrets.token_hex(32)


def random_nonce() -> str:
    """검증 요청 nonce: `n_` + 16바이트 hex."""
    return "n_" + secrets.token_hex(16)
