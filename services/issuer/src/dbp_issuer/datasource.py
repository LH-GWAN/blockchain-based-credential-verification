"""발급기관 내부 데이터 소스.

실서비스에서는 모바일 신분증·마이데이터·행정정보 연계 API 어댑터로 교체된다.
MVP 는 data/citizens.json 을 읽되, 발급기관이 '아는 필드'만 노출한다 (은행은 가구원수를 모른다).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol

from dbp_rules import repo_root


class IssuerDataSource(Protocol):
    def get_record(self, citizen_id: str) -> dict | None: ...
    def list_ids(self) -> list[str]: ...


class SeedDataSource:
    def __init__(self, known_fields: list[str], path: Path | None = None):
        p = path or repo_root() / "data/citizens.json"
        rows = json.loads(p.read_text(encoding="utf-8"))["citizens"]
        self._rows = {r["citizenId"]: {k: v for k, v in r.items() if k in known_fields} for r in rows}

    def get_record(self, citizen_id: str) -> dict | None:
        return self._rows.get(citizen_id)

    def list_ids(self) -> list[str]:
        return list(self._rows)
