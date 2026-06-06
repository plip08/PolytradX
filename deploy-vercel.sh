#!/usr/bin/env sh
set -eu

# Vercel deployment helper.
# Requires the Vercel CLI installed and a project already linked.
# Usage:
#   export VERCEL_ORG_ID=your_org_id
#   export VERCEL_PROJECT_ID=your_project_id
#   ./deploy-vercel.sh

if ! command -v vercel >/dev/null 2>&1; then
  echo "Error: Vercel CLI is not installed."
  echo "Install it with 'npm install -g vercel' or 'corepack enable && corepack prepare vercel@latest --activate'."
  exit 1
fi

if [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ]; then
  echo "Error: VERCEL_ORG_ID and VERCEL_PROJECT_ID must be set in the environment."
  echo "Set them before running this script. Example:"
  echo "  export VERCEL_ORG_ID=org_xxx"
  echo "  export VERCEL_PROJECT_ID=proj_xxx"
  exit 1
fi

printf "\n[1/3] Installing dependencies and building the UI...\n"
npm install
npm run vercel-build

printf "\n[2/3] Deploying to Vercel...\n"
vercel --confirm --prod

printf "\n[3/3] Deployment complete.\n"
printf "Use 'vercel ls' or the Vercel dashboard to verify the public URL.\n"
