FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 && rm -rf /var/lib/apt/lists/* \
 && npm i -g pnpm@12
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY chain/package.json chain/package.json
RUN pnpm install --frozen-lockfile --filter @dbp/chain
COPY chain chain
COPY pyproject.toml uv.lock ./
COPY packages packages
COPY services services
COPY data data
COPY scripts scripts
RUN uv sync --all-packages --frozen --no-dev
ENV DBP_REPO_ROOT=/app
