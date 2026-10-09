"""JCS (RFC 8785) 정규화와 SHA-256 해시.

우리 데이터는 정수/문자열/불리언/null/배열/객체만 쓰므로
`json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)` 가 곧 JCS이다.
TS `canonicalize()` 와 바이트 단위로 일치한다 (문자열 이스케이프 규칙·소문자 \\u00xx 동일).
키 정렬: Python은 코드포인트 순, JS는 UTF-16 코드유닛 순 — 둘이 갈리는 보조평면(비BMP) 문자 키는
양쪽 모두 거부하므로 받아들이는 입력에서는 항상 같다.
두 언어가 같은 입력만 받도록(F68) 다음도 양쪽에서 VcError 로 거부한다:
- 짝 없는 서로게이트(lone surrogate) — UTF-8 로 인코딩할 수 없다 (MALFORMED)
- ±(2^53-1) 밖의 정수 — JS number 로 정확히 표현되지 않는다 (FLOAT_FORBIDDEN)
"""

import hashlib
import json
from typing import Any

from .errors import VcError

MAX_SAFE_INTEGER = 2**53 - 1  # JS Number.MAX_SAFE_INTEGER


def _check_str(s: str, path: str, *, key: bool = False) -> None:
    # Python str 안의 서로게이트 코드포인트는 짝이 맞아도 UTF-8 로 인코딩할 수 없다 (json.loads 는
    # 짝 맞는 \ud83d\ude00 을 한 글자로 합치므로 남는 것은 모두 짝 없는 서로게이트다).
    try:
        s.encode("utf-8")
    except UnicodeEncodeError as e:
        raise VcError("MALFORMED", f"lone surrogate not allowed at {path}") from e
    if key and any(ord(c) > 0xFFFF for c in s):
        raise VcError("MALFORMED", f"object key outside the BMP not allowed at {path}: {s!r}")


def _check(v: Any, path: str = "$") -> None:
    """부동소수점·안전 범위 밖 정수·짝 없는 서로게이트·비BMP 키·비JSON 타입을 재귀적으로 거부한다."""
    if v is None or isinstance(v, bool):
        return
    if isinstance(v, str):
        _check_str(v, path)
        return
    if isinstance(v, float):
        raise VcError("FLOAT_FORBIDDEN", f"non-integer number not allowed at {path}: {v!r}")
    if isinstance(v, int):
        if not -MAX_SAFE_INTEGER <= v <= MAX_SAFE_INTEGER:
            raise VcError("FLOAT_FORBIDDEN", f"integer outside the JS safe range at {path}: {v}")
        return
    if isinstance(v, (list, tuple)):
        for i, item in enumerate(v):
            _check(item, f"{path}[{i}]")
        return
    if isinstance(v, dict):
        for k, item in v.items():
            if not isinstance(k, str):
                raise VcError("MALFORMED", f"object key must be str at {path}: {k!r}")
            _check_str(k, path, key=True)
            _check(item, f"{path}.{k}")
        return
    raise VcError("MALFORMED", f"cannot canonicalize value of type {type(v).__name__} at {path}")


def canonicalize(value: Any) -> str:
    """JCS 정규화 문자열. float가 섞여 있으면 FLOAT_FORBIDDEN."""
    _check(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(data: str | bytes) -> str:
    """SHA-256 hex (0x 없음). 문자열은 UTF-8로 인코딩한다."""
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    return hashlib.sha256(raw).hexdigest()


def bundle_hash(obj: Any) -> str:
    """번들 해시 = '0x' + SHA-256(JCS(obj)). RuleRegistry.registerBundle(bytes32) 입력과 동일."""
    return "0x" + sha256_hex(canonicalize(obj))
