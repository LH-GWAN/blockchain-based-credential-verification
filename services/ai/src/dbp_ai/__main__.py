"""`uv run python -m dbp_ai` → uvicorn 서버 (AI_HOST:AI_PORT, 기본 0.0.0.0:8004)."""
from __future__ import annotations

import logging

import uvicorn

from .config import Settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    s = Settings.from_env()
    uvicorn.run("dbp_ai.app:app", host=s.host, port=s.port, log_level="info")


if __name__ == "__main__":
    main()
