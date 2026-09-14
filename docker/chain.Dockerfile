FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 && rm -rf /var/lib/apt/lists/* \
 && npm i -g pnpm@12
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY chain/package.json chain/package.json
RUN pnpm install --frozen-lockfile --filter @dbp/chain
COPY chain chain
# 배포 컨테이너는 내부망(net-ops)이라 solc 를 내려받을 수 없다 → 빌드 시점에 컴파일해 컴파일러·아티팩트를 이미지에 포함
RUN pnpm --config.verify-deps-before-run=false --filter @dbp/chain compile
COPY pyproject.toml uv.lock ./
COPY packages packages
COPY services services
COPY data data
COPY scripts scripts
RUN uv sync --all-packages --frozen --no-dev
ENV DBP_REPO_ROOT=/app
# 런타임 `uv run` 이 (내부망에서) 의존성 동기화를 시도하지 않도록
ENV UV_NO_SYNC=1
