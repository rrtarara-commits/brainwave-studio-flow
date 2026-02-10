#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="${1:-}"

if [[ -z "$ENV_FILE" ]]; then
  echo "Usage: scripts/selfhost/print-selfhost-values.sh <path-to-selfhost-.env>"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE"
  exit 1
fi

get_env() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  echo "$line"
}

first_nonempty() {
  for key in "$@"; do
    local value
    value="$(get_env "$key")"
    if [[ -n "$value" ]]; then
      echo "$value"
      return 0
    fi
  done
  echo ""
}

SUPABASE_URL="$(first_nonempty API_EXTERNAL_URL SUPABASE_PUBLIC_URL SITE_URL)"
ANON_KEY="$(get_env ANON_KEY)"
SERVICE_ROLE_KEY="$(get_env SERVICE_ROLE_KEY)"

if [[ -z "$SUPABASE_URL" ]]; then
  SUPABASE_URL="http://localhost:8000"
fi

echo "# Paste into .env"
echo "VITE_SUPABASE_URL=\"$SUPABASE_URL\""
echo "VITE_SUPABASE_PUBLISHABLE_KEY=\"$ANON_KEY\""
echo "VITE_FUNCTIONS_BASE_URL=\"\""
echo
echo "# Paste into supabase/functions/.env"
echo "SUPABASE_URL=\"$SUPABASE_URL\""
echo "SUPABASE_ANON_KEY=\"$ANON_KEY\""
echo "SUPABASE_SERVICE_ROLE_KEY=\"$SERVICE_ROLE_KEY\""
