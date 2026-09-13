"""W3C Bitstring Status List v1.0 — 비트 i는 바이트 i>>3 의 MSB부터 (mask 0x80 >> (i & 7))."""

import gzip

from .errors import VcError
from .jws import b64url_decode, b64url_encode

DEFAULT_STATUS_LIST_SIZE = 131072  # 최소 비트 수 (16KiB)


def create_status_list(size: int = DEFAULT_STATUS_LIST_SIZE) -> bytearray:
    """모두 0(정상)인 비트열. size는 비트 수, 8의 배수."""
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0 or size % 8 != 0:
        raise VcError("MALFORMED", "status list size must be a positive multiple of 8")
    return bytearray(size // 8)


def _locate(lst: bytearray | bytes, index: int) -> tuple[int, int]:
    if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= len(lst) * 8:
        raise VcError("MALFORMED", f"status list index out of range: {index}")
    return index >> 3, 0x80 >> (index & 7)


def set_status(lst: bytearray, index: int, revoked: bool) -> None:
    """비트 설정 (in place). revoked=True → 1."""
    byte, mask = _locate(lst, index)
    if revoked:
        lst[byte] |= mask
    else:
        lst[byte] &= ~mask & 0xFF


def get_status(lst: bytearray | bytes, index: int) -> bool:
    """폐기 여부 조회."""
    byte, mask = _locate(lst, index)
    return (lst[byte] & mask) != 0


def encode_status_list(lst: bytearray | bytes) -> str:
    """gzip(mtime=0, 결정론적) → base64url(패딩 없음). StatusListRegistry.publish 의 encodedList.
    pako(TS) 출력과 gzip 헤더 바이트는 다르지만 서로 디코딩된다."""
    return b64url_encode(gzip.compress(bytes(lst), mtime=0))


def decode_status_list(encoded: str) -> bytearray:
    """base64url → gunzip. multibase 'u' 접두어가 붙은 W3C 표준 표현(uH4sI...)도 허용."""
    raw = encoded[1:] if encoded.startswith("uH4sI") else encoded
    try:
        return bytearray(gzip.decompress(b64url_decode(raw)))
    except (ValueError, OSError, EOFError) as e:
        raise VcError("MALFORMED", "encoded status list is not base64url(gzip)") from e
