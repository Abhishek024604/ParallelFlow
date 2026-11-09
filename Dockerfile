# ParallelFlow demo images (DEPLOY_PLAN.md step 1). One Dockerfile, two targets:
#   --target web       Next.js (next build + next start), port 3000. Needs --build-arg API_URL
#                      (the /v1 proxy target is fixed at build time, next.config.ts).
#   --target service   api / runtime / app-tools, run from TypeScript with tsx (SLICE_DEBT F21-04).
#                      Pick one with --build-arg SVC=api|runtime|app-tools.
# Persistent data lives on a volume at /data (api: arena repos, runtime: sessions); the entrypoint
# hands it to the non-root `node` user, then drops root.

FROM node:22-slim AS base
ENV CI=true NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/corepack
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# Dependencies: fetched from the lockfile alone (cached until pnpm-lock.yaml changes), then linked.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile

FROM deps AS web
ARG API_URL
ENV API_URL=${API_URL} NODE_ENV=production
RUN test -n "$API_URL" || (echo "build arg API_URL is required" && exit 1) \
  && pnpm --filter @parallelflow/web build \
  && chown -R node:node /app/apps/web/.next
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--port", "3000"]

FROM deps AS service
ARG SVC
ENV NODE_ENV=production
RUN test -n "$SVC" && test -d "/app/apps/$SVC" || (echo "build arg SVC=api|runtime|app-tools is required" && exit 1)
COPY --chmod=755 <<'EOF' /usr/local/bin/entrypoint
#!/bin/sh
set -e
if [ -d /data ]; then chown node:node /data; fi
exec gosu node "$@"
EOF
WORKDIR /app/apps/${SVC}
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
