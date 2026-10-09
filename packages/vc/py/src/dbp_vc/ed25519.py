"""Ed25519 원시 연산 (cryptography). 32바이트 시드 = 비밀키."""

from functools import lru_cache

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


# ---- 공개키 점 검사 (F67) ----
# 항등원 같은 small-order 공개키에서는 (R=항등원, S=0) 서명이 어떤 메시지에도 통과하고,
# 혼합 차수(torsion 성분이 섞인) 공개키는 cofactor 유무에 따라 TS(noble)와 판정이 갈린다.
# 정상 키(a·B)는 항상 소수 차수 부분군에 있으므로, 그 밖의 점은 양쪽에서 똑같이 거부한다.
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)
_IDENTITY = (0, 1, 1, 0)  # 확장 좌표 (X, Y, Z, T)


def _decode_point(data: bytes) -> tuple[int, int, int, int] | None:
    """RFC 8032 5.1.3 엄격 디코딩 (y < p, x=0 이면 부호 비트 0). 곡선 위 점이 아니면 None."""
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        if sign:
            return None
        return (0, y, 1, 0)
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P:
        return None
    if (x & 1) != sign:
        x = _P - x
    return (x, y, 1, x * y % _P)


def _add(p: tuple[int, int, int, int], q: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    a = (p[1] - p[0]) * (q[1] - q[0]) % _P
    b = (p[1] + p[0]) * (q[1] + q[0]) % _P
    c = 2 * p[3] * q[3] * _D % _P
    d = 2 * p[2] * q[2] % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(k: int, p: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    q = _IDENTITY
    while k:
        if k & 1:
            q = _add(q, p)
        p = _add(p, p)
        k >>= 1
    return q


def _is_identity(p: tuple[int, int, int, int]) -> bool:
    return p[0] % _P == 0 and (p[1] - p[2]) % _P == 0


@lru_cache(maxsize=256)
def _is_prime_order_point(data: bytes) -> bool:
    point = _decode_point(data)
    if point is None or _is_identity(_mul(8, point)):  # 디코딩 실패 또는 small-order(항등원 포함)
        return False
    return _is_identity(_mul(_L, point))  # torsion 성분이 없어야 한다


def ed25519_is_valid_public_key(public_key: bytes) -> bool:
    """32바이트 정규 인코딩이고, small-order·torsion 점이 아닌(소수 차수 부분군의) 공개키인지.
    TS `ed25519IsValidPublicKey` 와 같은 판정."""
    return len(public_key) == 32 and _is_prime_order_point(bytes(public_key))


def ed25519_verify(signature: bytes, message: bytes, public_key: bytes) -> bool:
    """Ed25519 검증. 서명 형식이 깨져도 예외 대신 False.
    small-order·torsion 공개키는 거부한다 (TS 와 같은 판정, F67). R·S 의 정규성과
    cofactor 없는 등식은 OpenSSL 이 검사한다."""
    if len(signature) != 64 or not ed25519_is_valid_public_key(public_key):
        return False
    try:
        Ed25519PublicKey.from_public_bytes(bytes(public_key)).verify(bytes(signature), bytes(message))
        return True
    except (InvalidSignature, ValueError):
        return False
