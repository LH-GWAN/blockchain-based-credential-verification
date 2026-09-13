"""Ed25519 원시 연산 (cryptography). 32바이트 시드 = 비밀키."""

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .errors import VcError


def _private(private_key: bytes) -> Ed25519PrivateKey:
    if len(private_key) != 32:
        raise VcError("MALFORMED", "Ed25519 private key must be 32 bytes")
    return Ed25519PrivateKey.from_private_bytes(bytes(private_key))


def ed25519_public_key(private_key: bytes) -> bytes:
    """32바이트 시드(비밀키)에서 Ed25519 공개키(32바이트)를 계산한다."""
    return _private(private_key).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )


def ed25519_public_key_hex(private_key: bytes) -> str:
    """온체인 IssuerRegistry.register(bytes32) 용 `0x` + 64 hex 공개키."""
    return "0x" + ed25519_public_key(private_key).hex()


def ed25519_sign(message: bytes, private_key: bytes) -> bytes:
    """Ed25519 서명 (64바이트, 결정론적)."""
    return _private(private_key).sign(bytes(message))


def ed25519_verify(signature: bytes, message: bytes, public_key: bytes) -> bool:
    """Ed25519 검증. 서명 형식이 깨져도 예외 대신 False."""
    if len(signature) != 64 or len(public_key) != 32:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(bytes(public_key)).verify(bytes(signature), bytes(message))
        return True
    except (InvalidSignature, ValueError):
        return False
