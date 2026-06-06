FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
COPY prisma ./prisma/

RUN if [ -f package-lock.json ]; then \
  npm ci --omit=dev; \
  else npm install --omit=dev; \
  fi

COPY . .
RUN npm run build

FROM node:20-slim AS runner

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN groupadd -r appuser && useradd -r -g appuser appuser && chown -R appuser:appuser /app
USER appuser

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(res=>res.ok?0:1).catch(()=>1)"

CMD ["node", "dist/index.js"]
