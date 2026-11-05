#!/usr/bin/env bash
# First deploy (and redeploys) to Fly.io. Needs: `fly auth login` done once.
# Usage: scripts/deploy-fly.sh [app-name]
set -euo pipefail
APP="${1:-$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)}"
REGION="$(sed -n 's/^primary_region = "\(.*\)"/\1/p' fly.toml)"

if ! fly apps list --json | grep -q "\"Name\": *\"$APP\""; then
  echo "creating app $APP"
  fly apps create "$APP"
fi
if ! fly volumes list -a "$APP" --json | grep -q countersign_data; then
  echo "creating volume"
  fly volumes create countersign_data -a "$APP" -r "$REGION" -s 1 -y
fi
URL="https://$APP.fly.dev"
# secrets: set once; APP_SECRET must never change after first deploy (it seals signing links)
if ! fly secrets list -a "$APP" | grep -q APP_SECRET; then
  fly secrets set -a "$APP" --stage APP_SECRET="$(openssl rand -hex 32)" APP_URL="$URL"
fi
fly deploy -a "$APP" --ha=false
curl -fsS "$URL/api/health" && echo " <- $URL is up"
