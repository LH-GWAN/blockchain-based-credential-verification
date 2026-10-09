"""did:key (Ed25519, multicodec 0xed01, base58btc 'z') 변환과 holder 키 생성."""

import re
import secrets
from dataclasses import dataclass

import base58

from .ed25519 import ed25519_is_valid_public_key, ed25519_public_key
from .errors import VcError

# multicodec ed25519-pub (0xed) 의 varint 표현
ED25519_MULTICODEC = b"\xed\x01"
DID_KEY_PREFIX = "did:key:z"
# base58btc 알파벳 + 선택적 fragment. 공백·개행·다른 문자는 받지 않는다 (TS 와 같은 정규식, F68).
# fullmatch 로 검사한다 — `$` 는 끝 개행 앞에서도 일치하기 때문.
DID_KEY_RE = re.compile(r"did:key:z[1-9A-HJ-NP-Za-km-z]+(?:#[A-Za-z0-9._~-]+)?")


@dataclass(frozen=True)
class HolderKey:
    """private_key: 32바이트 Ed25519 시드 (지갑에만 보관, 절대 전송 금지)."""

    private_key: bytes
    public_key: bytes
    did: str


def public_key_to_did_key(public_key: bytes) -> str:
    """Ed25519 공개키 → `did:key:z6Mk...`."""
    if len(public_key) != 32:
        raise VcError("MALFORMED", "Ed25519 public key must be 32 bytes")
    return DID_KEY_PREFIX + base58.b58encode(ED25519_MULTICODEC + bytes(public_key)).decode("ascii")


def did_key_to_public_key(did: str) -> bytes:
    """`did:key:z6Mk...`(fragment 허용) → Ed25519 공개키 32바이트.
    small-order·torsion 공개키(예: 항등원)는 MALFORMED 로 거부한다 (F67)."""
    if not isinstance(did, str) or not DID_KEY_RE.fullmatch(did):
        raise VcError("MALFORMED", f"not a did:key (base58btc): {did}")
    bare = did.split("#", 1)[0]
    try:
        raw = base58.b58decode(bare[len(DID_KEY_PREFIX) :])
    except ValueError as e:
        raise VcError("MALFORMED", "did:key is not valid base58btc") from e
    if len(raw) != 34 or raw[:2] != ED25519_MULTICODEC:
        raise VcError("MALFORMED", "did:key is not an Ed25519 key")
    if not ed25519_is_valid_public_key(raw[2:]):
        raise VcError("MALFORMED", "did:key public key is small-order or not in the prime-order subgroup")
    return raw[2:]


def generate_holder_key(seed: bytes | None = None) -> HolderKey:
    """holder 키 생성. seed(32바이트)를 주면 결정론적, 없으면 CSPRNG."""
    private_key = bytes(seed) if seed is not None else secrets.token_bytes(32)
    if len(private_key) != 32:
        raise VcError("MALFORMED", "seed must be 32 bytes")
    public_key = ed25519_public_key(private_key)
    return HolderKey(private_key=private_key, public_key=public_key, did=public_key_to_did_key(public_key))
