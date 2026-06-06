# Polymarket Quant Bot

## Quick start

1. Copy `.env.example` to `.env` and fill the required values.
2. Build:
   ```bash
   npm install
   npm run build
   ```
3. Run locally:
   ```bash
   npm start
   ```

## Docker

Build the image:
```bash
npm run docker:build
```

Start the stack:
```bash
npm run docker:up
```

Stop the stack:
```bash
npm run docker:down
```

## Deployment

### VPS (backend + Redis + PostgreSQL)

1. Copy `.env.example` to `.env` on the VPS.
2. Fill in the real secrets and remote proxy URL.
3. Run the VPS setup helper:
   ```bash
   chmod +x setup-vps.sh deploy.sh
   ./setup-vps.sh
   ```
4. Then deploy the stack:
   ```bash
   ./deploy.sh
   ```
5. Check service health:
   ```bash
   docker compose ps
   docker compose logs -f backend
   ```

### Vercel (frontend)

1. Push the repository to GitHub.
2. Connect the repo to Vercel.
3. Add environment variables in Vercel:
   - `NEXT_PUBLIC_CONTROL_API_URL`
   - `NEXT_PUBLIC_TELEMETRY_WS_URL`
4. Use the helper script:
   ```bash
   chmod +x deploy-vercel.sh
   VERCEL_ORG_ID=your_org_id VERCEL_PROJECT_ID=your_project_id ./deploy-vercel.sh
   ```

### Vercel environment variables

- `NEXT_PUBLIC_CONTROL_API_URL`: URL publique de ton API backend
- `NEXT_PUBLIC_TELEMETRY_WS_URL`: WebSocket de télémétrie
- `NEXT_PUBLIC_APP_TITLE`: nom affiché dans l’UI
- `NEXT_PUBLIC_ENVIRONMENT`: `production`

### Notes

- The backend stack is designed pour tourner sur un VPS étranger.
- Utilise un proxy résidentiel HTTP/SOCKS5 si l’API Polymarket bloque les IP cloud.
- Si ton budget est serré, garde PostgreSQL en Docker sur le VPS, mais sauvegarde la DB régulièrement.

## Health endpoints

- `GET /health/live` - liveness probe
- `GET /health/ready` - readiness probe (checks Redis and PostgreSQL)
- `GET /health` - general health endpoint (alias to readiness)
- `GET /metrics` - Prometheus metrics endpoint

## API

- `POST /api/commands` - enqueue bot commands
- `GET /api/snapshot` - latest bot snapshot
- `GET /api/circuit-breaker` - circuit breaker state
- `GET /api/strategy-config` - strategy configuration list
- `GET /api/trades` - historical trades
- `GET /api/risk-events` - risk events

## Testing

Run unit and API tests:
```bash
npm test
```
