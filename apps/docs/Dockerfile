# syntax=docker/dockerfile:1
#
# Monorepo image for the Unified Gateway documentation site (Next.js + Fumadocs).
# The BUILD CONTEXT is the repo ROOT (it needs the workspace manifests and lockfile), so build from
# the root with:
#
#   docker build -f apps/docs/Dockerfile -t unified-docs .
#
# Dependencies are installed with Bun and the site is compiled with `next build` (Bun), but it is
# SERVED with the standard `next start` server on Node 24 — Next.js's production server is Node-based
# (unlike the gateway, which runs on Bun). The docs build makes no outbound TLS calls (no next/font
# downloads), so Bun is safe for the build step here.

# ---- deps: full install (the build needs devDependencies) ----
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/docs/package.json ./apps/docs/package.json
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
RUN bun install --frozen-lockfile --filter @boelabs/docs

# ---- build: next build ----
FROM oven/bun:1.3.14 AS build
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps/docs ./apps/docs
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/docs/node_modules ./apps/docs/node_modules
RUN cd apps/docs && bun run build

# ---- runtime: Node 24, `next start` ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app/apps/docs
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Carry the built app as-is (`.next`, node_modules, content, and config). `next start` reads these at
# boot — no standalone bundling, just the normal production server.
COPY --chown=node:node --from=build /app /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "./node_modules/next/dist/bin/next", "start"]
