#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ID="${1:-}"
FUNCTIONS_ENV="${ROOT_DIR}/supabase/functions/.env"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: scripts/selfhost/sync-gcp-secrets.sh <GCP_PROJECT_ID>"
  exit 1
fi

if [[ ! -f "$FUNCTIONS_ENV" ]]; then
  echo "Missing file: $FUNCTIONS_ENV"
  exit 1
fi

get_env() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$FUNCTIONS_ENV" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  echo "$line"
}

upsert_secret() {
  local name="$1"
  local value="$2"

  if [[ -z "$value" ]]; then
    echo "Skipping $name (empty value)"
    return 0
  fi

  if gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo -n "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT_ID" >/dev/null
    echo "Updated secret version: $name"
  else
    echo -n "$value" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic --project "$PROJECT_ID" >/dev/null
    echo "Created secret: $name"
  fi
}

SUPABASE_SERVICE_ROLE_KEY="$(get_env SUPABASE_SERVICE_ROLE_KEY)"
GCP_CALLBACK_SECRET="$(get_env GCP_CALLBACK_SECRET)"

gcloud config set project "$PROJECT_ID" >/dev/null

upsert_secret "SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_SERVICE_ROLE_KEY"
upsert_secret "GCP_CALLBACK_SECRET" "$GCP_CALLBACK_SECRET"

echo "GCP secret sync complete for project: $PROJECT_ID"
