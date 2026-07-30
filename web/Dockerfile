# syntax=docker/dockerfile:1.7

FROM node:22.23.1-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile --filter @epode/web...

# --- builder ---
FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY web ./web
# `public/` is currently empty but remains part of the standalone runtime
# contract so future static assets require no Dockerfile change.
RUN mkdir -p web/public && pnpm --filter @epode/web build

# --- runtime ---
FROM node:22.23.1-bookworm-slim AS runtime
WORKDIR /app

COPY --from=builder --chown=node:node /app/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/web/.next/static ./web/.next/static
COPY --from=builder --chown=node:node /app/web/public ./web/public

USER node

ENV NODE_ENV=production
ENV PORT=3000
# Next.js standalone `server.js` binds to process.env.HOSTNAME, which Docker
# auto-sets to the container short ID. Without this override the server
# listens only on that hostname and Railway's edge cannot reach it (502).
# `::` dual-stacks on Linux so both public edge (v4) and private network
# (v6 via *.railway.internal) work.
ENV HOSTNAME=::
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node --eval "fetch('http://localhost:' + (process.env.PORT || 3000) + '/').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "web/server.js"]
