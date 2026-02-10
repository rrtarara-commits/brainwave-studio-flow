#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${1:-}"

if [[ -z "$ENV_FILE" ]]; then
  echo "Usage: scripts/selfhost/apply-selfhost-values.sh <path-to-selfhost-.env>"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE"
  exit 1
fi

FRONTEND_ENV="${ROOT_DIR}/.env"
FUNCTIONS_ENV="${ROOT_DIR}/supabase/functions/.env"

mkdir -p "${ROOT_DIR}/supabase/functions"
[[ -f "$FRONTEND_ENV" ]] || cp "${ROOT_DIR}/.env.example" "$FRONTEND_ENV"
[[ -f "$FUNCTIONS_ENV" ]] || cp "${ROOT_DIR}/supabase/functions/.env.example" "$FUNCTIONS_ENV"

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

replace_or_add() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp)"

  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" {
      print key "=\"" value "\""
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print key "=\"" value "\""
      }
    }
  ' "$file" > "$tmp_file"

  mv "$tmp_file" "$file"
}

SUPABASE_URL="$(first_nonempty API_EXTERNAL_URL SUPABASE_PUBLIC_URL SITE_URL)"
ANON_KEY="$(get_env ANON_KEY)"
SERVICE_ROLE_KEY="$(get_env SERVICE_ROLE_KEY)"

if [[ -z "$SUPABASE_URL" ]]; then
  SUPABASE_URL="http://localhost:8000"
  echo "Warning: no API_EXTERNAL_URL/SUPABASE_PUBLIC_URL/SITE_URL found. Using $SUPABASE_URL"
fi

if [[ -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" ]]; then
  echo "Missing ANON_KEY or SERVICE_ROLE_KEY in $ENV_FILE"
  exit 1
fi

replace_or_add "$FRONTEND_ENV" "VITE_SUPABASE_URL" "$SUPABASE_URL"
replace_or_add "$FRONTEND_ENV" "VITE_SUPABASE_PUBLISHABLE_KEY" "$ANON_KEY"

replace_or_add "$FUNCTIONS_ENV" "SUPABASE_URL" "$SUPABASE_URL"
replace_or_add "$FUNCTIONS_ENV" "SUPABASE_ANON_KEY" "$ANON_KEY"
replace_or_add "$FUNCTIONS_ENV" "SUPABASE_SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY"

echo "Updated:"
echo "- $FRONTEND_ENV"
echo "- $FUNCTIONS_ENV"
echo
echo "Next: run npm run selfhost:check-env"
