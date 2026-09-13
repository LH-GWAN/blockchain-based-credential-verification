"""환경변수 설정. 매 요청마다 읽어도 될 만큼 가볍다 (테스트에서 monkeypatch.setenv 가 바로 반영되도록 캐시하지 않는다)."""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_MODEL = "claude-opus-5"
DEFAULT_PORT = 8004


@dataclass(frozen=True)
class Settings:
    provider: str  # 요청된 provider: "anthropic" | "template"
    model: str
    api_key: str | None
    host: str
    port: int
    timeout_s: float

    @classmethod
    def from_env(cls) -> Settings:
        provider = (os.environ.get("LLM_PROVIDER") or "anthropic").strip().lower()
        if provider not in ("anthropic", "template"):
            provider = "anthropic"
        api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip() or None
        return cls(
            provider=provider,
            model=(os.environ.get("LLM_MODEL") or DEFAULT_MODEL).strip(),
            api_key=api_key,
            host=os.environ.get("AI_HOST") or "0.0.0.0",
            port=int(os.environ.get("AI_PORT") or DEFAULT_PORT),
            timeout_s=float(os.environ.get("LLM_TIMEOUT_S") or 60.0),
        )
