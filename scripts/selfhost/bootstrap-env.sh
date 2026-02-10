#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

frontend_example="${ROOT_DIR}/.env.example"
frontend_env="${ROOT_DIR}/.env"
functions_example="${ROOT_DIR}/supabase/functions/.env.example"
functions_env="${ROOT_DIR}/supabase/functions/.env"

if [[ ! -f "$frontend_example" ]]; then
  echo "Missing template: $frontend_example"
  exit 1
fi

if [[ ! -f "$functions_example" ]]; then
  echo "Missing template: $functions_example"
  exit 1
fi

if [[ -f "$frontend_env" ]]; then
  echo "Exists: $frontend_env (left unchanged)"
else
  cp "$frontend_example" "$frontend_env"
  echo "Created: $frontend_env"
fi

if [[ -f "$functions_env" ]]; then
  echo "Exists: $functions_env (left unchanged)"
else
  cp "$functions_example" "$functions_env"
  echo "Created: $functions_env"
fi

echo
echo "Next:"
echo "1) Fill in values in .env and supabase/functions/.env"
echo "2) Run: npm run selfhost:check-env"
