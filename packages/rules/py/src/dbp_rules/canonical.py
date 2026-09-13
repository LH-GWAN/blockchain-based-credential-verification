"""JCS(RFC 8785) 호환 정규화. 프로젝트 데이터는 정수·문자열·불리언·null·배열·객체만 쓴다.
부동소수점은 언어 간 표현이 달라질 수 있으므로 금지한다."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def _reject_floats(value: Any, path: str = "$") -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, float):
        raise ValueError(f"float not allowed at {path}")
    if isinstance(value, dict):
        for k, v in value.items():
            _reject_floats(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _reject_floats(v, f"{path}[{i}]")


def canonicalize(value: Any) -> str:
    _reject_floats(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()
