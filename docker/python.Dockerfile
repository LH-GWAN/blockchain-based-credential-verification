FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock pnpm-workspace.yaml ./
COPY packages/rules/py packages/rules/py
COPY packages/vc/py packages/vc/py
COPY packages/ledger-client/py packages/ledger-client/py
COPY packages/rules/bundles packages/rules/bundles
COPY services services
COPY data data
COPY scripts scripts
RUN uv sync --all-packages --frozen --no-dev
ENV DBP_REPO_ROOT=/app
# 런타임 `uv run` 이 (내부망에서) 의존성 동기화를 시도하지 않도록
ENV UV_NO_SYNC=1
