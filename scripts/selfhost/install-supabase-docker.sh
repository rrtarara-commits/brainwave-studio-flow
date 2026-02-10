#!/usr/bin/env bash

set -euo pipefail

TARGET_DIR="${1:-$HOME/supabase-selfhost}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -d "$TARGET_DIR" ]] && [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
  echo "Target directory is not empty: $TARGET_DIR"
  echo "Use an empty directory or remove existing files first."
  exit 1
fi

mkdir -p "$TARGET_DIR"

echo "Cloning official Supabase repo..."
git clone --depth 1 https://github.com/supabase/supabase.git "$TMP_DIR/supabase"

if [[ ! -d "$TMP_DIR/supabase/docker" ]]; then
  echo "Could not find docker stack in cloned Supabase repo."
  exit 1
fi

echo "Copying docker stack to $TARGET_DIR..."
cp -R "$TMP_DIR/supabase/docker/." "$TARGET_DIR/"

if [[ -f "$TARGET_DIR/.env.example" ]] && [[ ! -f "$TARGET_DIR/.env" ]]; then
  cp "$TARGET_DIR/.env.example" "$TARGET_DIR/.env"
fi

echo
echo "Supabase self-host stack installed at: $TARGET_DIR"
echo
echo "Next steps:"
echo "1) Edit $TARGET_DIR/.env (set strong passwords/secrets before internet exposure)."
echo "2) Start stack:"
echo "   cd $TARGET_DIR && docker compose pull && docker compose up -d"
echo "3) Export keys for this app:"
echo "   scripts/selfhost/print-selfhost-values.sh \"$TARGET_DIR/.env\""
echo "4) Apply keys into this repo env files:"
echo "   scripts/selfhost/apply-selfhost-values.sh \"$TARGET_DIR/.env\""
