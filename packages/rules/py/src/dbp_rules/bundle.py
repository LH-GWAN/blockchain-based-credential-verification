"""규칙 번들 조합과 해시.

번들 = { bundle, version, preprocess, claims, policies, tables }.
tables 는 data/median-income-2026.json 에서 파생한다. 해시 = sha256(JCS(번들)).
TS 구현(@dbp/rules)과 동일한 객체를 만들어야 하므로 여기서 필드를 추가·삭제하면 양쪽을 같이 고친다.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .canonical import canonicalize, sha256_hex
from .paths import repo_root


def _read(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8"))


def compose_bundle(bundle: str, version: str, preprocess: dict, claims: dict, policies: dict,
                   median_income: dict) -> dict:
    tables = {
        "medianIncomeByHouseholdSize": {k: int(v) for k, v in median_income["byHouseholdSize"].items()},
        "basicPensionLineByHouseholdKind": {
            "single": int(median_income["basicPension2026"]["singleKRW"]),
            "couple": int(median_income["basicPension2026"]["coupleKRW"]),
        },
        "medianIncomeSource": median_income["source"],
        "medianIncomeYear": int(median_income["year"]),
    }
    return {
        "bundle": bundle,
        "version": version,
        "preprocess": preprocess,
        "claims": claims,
        "policies": policies,
        "tables": tables,
    }


def load_bundle(bundle: str = "daegu-eligibility", version: str = "2026.1", root: Path | None = None) -> dict:
    root = root or repo_root()
    base = root / "packages/rules/bundles" / bundle / version
    return compose_bundle(
        bundle, version,
        _read(base / "preprocess.json"),
        _read(base / "claims.json"),
        _read(base / "policies.json"),
        _read(root / "data/median-income-2026.json"),
    )


def bundle_hash(b: dict) -> str:
    return "0x" + sha256_hex(canonicalize(b))


def schema_hash() -> str:
    """원자적 claim VC 스키마 식별자의 해시 (스키마 자체는 packages/vc 가 고정)."""
    return "0x" + sha256_hex(canonicalize({"id": "dbp:schema:atomic-claim:1", "type": "JsonSchema",
                                            "subject": {"id": "did", "<claim>": "boolean"}}))
