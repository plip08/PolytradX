# Monitoring Setup Guide

## Overview

This project includes a complete monitoring stack with Prometheus and Grafana to track bot performance, trades, and system health.

## Components

### Prometheus
- **Port**: 9090
- **Config**: `monitoring/prometheus.yml`
- **Alerts**: `monitoring/alert_rules.yml`
- Scrapes metrics from the bot's `/metrics` endpoint every 15 seconds

### Grafana
- **Port**: 3001
- **Default credentials**: admin / admin
- **Dashboard**: Pre-configured Polymarket Bot dashboard
- Visualizes metrics collected by Prometheus

### Node Exporter
- **Port**: 9100
- Collects system-level metrics (CPU, memory, disk, network)

## Quick Start

### 1. Start the monitoring stack

```bash
docker-compose up -d prometheus grafana node-exporter
```

### 2. Access Grafana

Open your browser and navigate to:
```
http://localhost:3001
```

Login with:
- **Username**: admin
- **Password**: admin

### 3. Add Prometheus as a data source

1. Go to Configuration → Data Sources
2. Click "Add data source"
3. Select "Prometheus"
4. Set URL to: `http://prometheus:9090`
5. Click "Save & Test"

### 4. Import the dashboard

The dashboard should be automatically provisioned. If not:
1. Go to Dashboards → Import
2. Upload `monitoring/grafana-dashboard.json`

## Metrics Exposed

The bot exposes the following metrics at `GET /metrics`:

### Trading Metrics
- `trades_total{strategy}` - Total number of trades per strategy
- `trades_successful_total{strategy}` - Successful trades per strategy
- `trade_size_usd` - Trade size in USD
- `pnl_usd{strategy}` - Profit/Loss in USD per strategy

### Bot Status
- `bot_status` - 1 if running, 0 if stopped
- `circuit_breaker_status` - 1 if tripped, 0 if normal

### Risk Metrics
- `risk_events_total{severity}` - Count of risk events by severity
- `position_size_usd{market_id}` - Current position size per market
- `daily_loss_usd` - Current daily loss

### System Metrics (via node-exporter)
- CPU usage
- Memory usage
- Disk I/O
- Network traffic

## Alerts

Pre-configured alerts in `monitoring/alert_rules.yml`:

1. **BotDown** - Triggers if bot is unreachable for >1 minute
2. **CircuitBreakerTripped** - Alerts when circuit breaker activates
3. **HighRiskEvents** - Triggers on >6 high-severity events/minute
4. **LowWinRate** - Alerts if win rate <50% over 1 hour
5. **DailyLossLimitApproaching** - Warns when daily loss approaches -$10k
6. **HighMemoryUsage** - Alerts when available memory <10%

## Dashboard Panels

The Grafana dashboard includes:

1. **Bot Status** - Real-time bot health
2. **Total Trades (24h)** - Trading volume
3. **Circuit Breaker Status** - Safety mechanism state
4. **P&L (USD)** - Cumulative profit/loss
5. **Trades by Strategy** - Strategy performance comparison
6. **Win Rate by Strategy** - Success rate per strategy
7. **Average Trade Size** - Position sizing over time
8. **Risk Events** - Safety alerts timeline

## Production Deployment

### On VPS

1. Ensure monitoring stack is running:
```bash
docker-compose up -d prometheus grafana node-exporter backend
```

2. Configure firewall to allow access to Grafana (port 3001) from trusted IPs only

3. Change default Grafana password:
```bash
docker exec -it polymarket-quant-bot-grafana grafana-cli admin reset-admin-password <new-password>
```

### External Monitoring

To monitor from external tools:
- Prometheus metrics are available at: `http://your-vps-ip:3000/metrics`
- Consider setting up Prometheus federation or remote write for long-term storage

## Troubleshooting

### Prometheus not scraping

Check if the bot's metrics endpoint is accessible:
```bash
curl http://localhost:3000/metrics
```

### Grafana not showing data

1. Verify Prometheus data source connection
2. Check Prometheus targets: http://localhost:9090/targets
3. Ensure time range in Grafana matches available data

### Alerts not firing

Check Prometheus alerts page: http://localhost:9090/alerts

## Customization

### Add custom metrics

In your service code:
```typescript
import { register, Counter, Gauge } from 'prom-client';

const myCustomMetric = new Counter({
  name: 'my_custom_metric',
  help: 'Description of metric',
  labelNames: ['label1', 'label2']
});

myCustomMetric.inc({ label1: 'value1', label2: 'value2' });
```

### Modify dashboard

1. Edit `monitoring/grafana-dashboard.json`
2. Restart Grafana: `docker-compose restart grafana`

### Add alert rules

1. Edit `monitoring/alert_rules.yml`
2. Reload Prometheus: `docker-compose restart prometheus`
