#!/usr/bin/env sh
set -eu

# Init helper for a fresh VPS.
# Usage:
#   cp .env.example .env
#   vi .env
#   ./setup-vps.sh

if [ ! -f .env ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill it first."
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  echo "Docker is already installed."
else
  echo "Docker is not installed. Attempting installation..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg lsb-release
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(lsb_release -cs) stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  elif command -v apk >/dev/null 2>&1; then
    sudo apk update
    sudo apk add docker docker-compose
  else
    echo "Unsupported package manager. Install Docker manually: https://docs.docker.com/get-docker/"
    exit 1
  fi
fi

if command -v docker >/dev/null 2>&1; then
  echo "Docker installed successfully."
else
  echo "Docker installation failed. Please install Docker manually."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is available."
else
  echo "Docker Compose is not available."
  if command -v docker-compose >/dev/null 2>&1; then
    echo "Found legacy docker-compose binary. Continuing with that."
  else
    echo "Install Docker Compose plugin or binary before running the deploy scripts."
    exit 1
  fi
fi

printf "\nCreating .env from .env.example if missing...\n"
if [ ! -f .env ]; then
  cp .env.example .env
  printf "Created .env from .env.example. Edit the file and rerun this script.\n"
  exit 0
fi

printf "\nChecking docker compose manifest...\n"
docker compose config >/dev/null

printf "\nBringing up the stack...\n"
docker compose up -d

printf "\nSetup complete.\n"
docker compose ps
printf "\nFollow backend logs with:\n  docker compose logs -f backend\n"
