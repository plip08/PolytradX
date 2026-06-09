# Builds the v2 bot (backend/). Build context is the repo root.
# ── Builder ───────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Prisma engines need openssl
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Install deps (incl. dev — tsup/prisma CLI are needed to build) against the lockfile
COPY backend/package*.json ./
RUN npm ci

# Generate the Prisma client from the backend schema
COPY backend/prisma ./prisma/
RUN npx prisma generate

# Compile (tsup → dist/index.js)
COPY backend/tsconfig.json ./
COPY backend/src ./src/
RUN npm run build

# Drop dev deps for a lean runtime image (keeps @prisma/client + generated client)
RUN npm prune --omit=dev

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN groupadd -r appuser && useradd -r -g appuser appuser && chown -R appuser:appuser /app
USER appuser

ENV NODE_ENV=production
# API (REST control plane) + WS (dashboard telemetry)
EXPOSE 3001 8080

# v2 exposes an unauthenticated /health on API_PORT (default 3001)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
