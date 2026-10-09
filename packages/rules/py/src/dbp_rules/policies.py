from __future__ import annotations

import json
from pathlib import Path

from .paths import repo_root


def load_policies(root: Path | None = None) -> list[dict]:
    root = root or repo_root()
    items = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((root / "data/policies").glob("*.json"))]
    return items


def policy_index(root: Path | None = None) -> dict[str, dict]:
    return {p["policyId"]: p for p in load_policies(root)}


def claim_sets(policy: dict) -> list[list[dict]]:
    """정책을 참으로 만드는 증명 조합(anyOf). 각 조합은 {claim, expected} 의 AND 다.
    issuerOf 가 'self' 인 항목(신용평점)도 들어 있으며, 그 항목은 창구가 직접 확인한다.
    2026.2 이전 형식(requiredClaims 단일 목록)도 조합 하나로 읽는다."""
    if "requiredClaimSets" in policy:
        return policy["requiredClaimSets"]
    return [policy["requiredClaims"]] if policy.get("requiredClaims") else []
