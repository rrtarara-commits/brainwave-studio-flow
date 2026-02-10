#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_URL="${1:-${SUPABASE_DB_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  echo "Usage:"
  echo "  scripts/selfhost/migrate-db.sh \"postgresql://postgres:<password>@<host>:5432/postgres\""
  echo "or set SUPABASE_DB_URL and run without args."
  exit 1
fi

echo "Running migrations against provided DB URL..."
cd "$ROOT_DIR"
npx --yes supabase db push --db-url "$DB_URL"
echo "Migration complete."
