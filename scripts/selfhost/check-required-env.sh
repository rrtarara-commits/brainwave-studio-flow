#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

check_var() {
  local file="$1"
  local key="$2"
  if ! grep -Eq "^${key}=" "$file"; then
    echo "Missing ${key} in ${file}"
    return 1
  fi
  return 0
}

read_var() {
  local file="$1"
  local key="$2"
  local raw
  raw="$(grep -E "^${key}=" "$file" | head -n 1 | cut -d'=' -f2- || true)"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  echo "$raw"
}

ensure_not_placeholder() {
  local file="$1"
  local key="$2"
  local value
  value="$(read_var "$file" "$key")"

  if [[ -z "$value" ]]; then
    echo "Empty value for ${key} in ${file}"
    return 1
  fi

  if [[ "$value" == *"replace-with"* || "$value" == *"your-supabase-domain.example.com"* || "$value" == *"your-video-analysis-bucket"* ]]; then
    echo "Placeholder value for ${key} in ${file}"
    return 1
  fi

  return 0
}

require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "Missing required file: ${file}"
    return 1
  fi
  return 0
}

frontend_env="${ROOT_DIR}/.env"
functions_env="${ROOT_DIR}/supabase/functions/.env"

require_file "$frontend_env"
require_file "$functions_env"

check_var "$frontend_env" "VITE_SUPABASE_URL"
check_var "$frontend_env" "VITE_SUPABASE_PUBLISHABLE_KEY"
ensure_not_placeholder "$frontend_env" "VITE_SUPABASE_URL"
ensure_not_placeholder "$frontend_env" "VITE_SUPABASE_PUBLISHABLE_KEY"

check_var "$functions_env" "SUPABASE_URL"
check_var "$functions_env" "SUPABASE_ANON_KEY"
check_var "$functions_env" "SUPABASE_SERVICE_ROLE_KEY"
check_var "$functions_env" "LOVABLE_API_KEY"
check_var "$functions_env" "GCS_BUCKET"
check_var "$functions_env" "GCP_CALLBACK_SECRET"
ensure_not_placeholder "$functions_env" "SUPABASE_URL"
ensure_not_placeholder "$functions_env" "SUPABASE_ANON_KEY"
ensure_not_placeholder "$functions_env" "SUPABASE_SERVICE_ROLE_KEY"
ensure_not_placeholder "$functions_env" "LOVABLE_API_KEY"
ensure_not_placeholder "$functions_env" "GCS_BUCKET"
ensure_not_placeholder "$functions_env" "GCP_CALLBACK_SECRET"

echo "Self-host environment check passed."
