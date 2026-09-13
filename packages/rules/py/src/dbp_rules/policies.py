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
