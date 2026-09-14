FROM node:22-slim AS build
ARG APP
RUN npm i -g pnpm@12
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/vc/ts packages/vc/ts
COPY packages/rules/ts packages/rules/ts
COPY apps/${APP} apps/${APP}
COPY data data
COPY packages/rules/bundles packages/rules/bundles
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter './packages/**' build && pnpm --filter ./apps/${APP} build

FROM node:22-slim
ARG APP
ENV APP=${APP}
WORKDIR /app
COPY --from=build /app /app
ENV PORT=3000
CMD ["sh", "-c", "cd apps/${APP} && npx next start -p 3000"]
