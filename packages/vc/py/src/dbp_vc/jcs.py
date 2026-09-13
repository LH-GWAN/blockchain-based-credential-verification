"""JCS (RFC 8785) 정규화와 SHA-256 해시.

우리 데이터는 정수/문자열/불리언/null/배열/객체만 쓰므로
`json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)` 가 곧 JCS이다.
TS `canonicalize()` 와 바이트 단위로 일치한다 (문자열 이스케이프 규칙·소문자 \\u00xx 동일).
키 정렬: Python은 코드포인트 순, JS는 UTF-16 코드유닛 순 — BMP 문자만 쓰는 이 프로젝트에서는 동일하다.
"""

import hashlib
import json
from typing import Any

from .errors import VcError


def _check(v: Any, path: str = "$") -> None:
    """부동소수점·비JSON 타입을 재귀적으로 거부한다."""
    if v is None or isinstance(v, (bool, str)):
        return
    if isinstance(v, float):
        raise VcError("FLOAT_FORBIDDEN", f"non-integer number not allowed at {path}: {v!r}")
    if isinstance(v, int):
        return
    if isinstance(v, (list, tuple)):
        for i, item in enumerate(v):
            _check(item, f"{path}[{i}]")
        return
    if isinstance(v, dict):
        for k, item in v.items():
            if not isinstance(k, str):
                raise VcError("MALFORMED", f"object key must be str at {path}: {k!r}")
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
