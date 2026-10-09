"""환경변수 설정. 매 요청마다 읽어도 될 만큼 가볍다 (테스트에서 monkeypatch.setenv 가 바로 반영되도록 캐시하지 않는다)."""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_MODEL = "claude-opus-5"
DEFAULT_PORT = 8004
# 지갑이 /recommend 를 포기하기 전에 템플릿 폴백이 먼저 일어나도록 짧게 둔다 (F18). SDK 재시도는 하지 않는다.
DEFAULT_TIMEOUT_S = 25.0
DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:3000,http://localhost:3001,http://localhost:3010,http://localhost:3011,"
    "http://127.0.0.1:3000,http://127.0.0.1:3001,http://127.0.0.1:3010,http://127.0.0.1:3011"
)


def allowed_origins() -> list[str]:
    """CORS 허용 출처 (ALLOWED_ORIGINS, 쉼표 구분). 기본은 지갑·검증기관 앱의 로컬 주소뿐이다."""
    raw = os.environ.get("ALLOWED_ORIGINS") or DEFAULT_ALLOWED_ORIGINS
    return [o.strip() for o in raw.split(",") if o.strip()]


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
            # 기본은 루프백만. 컨테이너에서는 compose 가 HOST=0.0.0.0 을 준다 (AI_HOST 는 옛 이름).
            host=os.environ.get("HOST") or os.environ.get("AI_HOST") or "127.0.0.1",
            port=int(os.environ.get("AI_PORT") or DEFAULT_PORT),
            timeout_s=float(os.environ.get("LLM_TIMEOUT_S") or DEFAULT_TIMEOUT_S),
        )
