#!/usr/bin/env sh
set -eu

# Deployment helper for the VPS environment.
# Usage:
#   cp .env.example .env
#   vi .env
#   ./deploy.sh

if [ ! -f .env ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill in your secrets first."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed. Install Docker before running this script."
  exit 1
fi

if ! command -v docker-compose >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose is not available. Install Docker Compose or use Docker CLI plugin."
  exit 1
fi

printf "\n[1/4] Checking docker compose configuration...\n"

docker compose config >/dev/null

printf "\n[2/4] Building backend image...\n"
docker compose build backend

printf "\n[3/4] Starting services...\n"
docker compose up -d

printf "\n[4/4] Deployment completed. Current service status:\n"
docker compose ps

printf "\nBackend health endpoint should be available after startup on port 3000.\n"

printf "\nRun this to follow backend logs:\n"
printf "  docker compose logs -f backend\n"
