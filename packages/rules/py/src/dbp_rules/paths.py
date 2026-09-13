from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    """환경변수 DBP_REPO_ROOT 또는 pnpm-workspace.yaml 을 찾아 올라간다."""
    env = os.environ.get("DBP_REPO_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise RuntimeError("repo root not found (set DBP_REPO_ROOT)")
