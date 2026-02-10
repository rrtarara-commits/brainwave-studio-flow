#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ID="${1:-}"
SUPABASE_URL="${2:-}"
GCS_BUCKET="${3:-}"

if [[ -z "$PROJECT_ID" || -z "$SUPABASE_URL" || -z "$GCS_BUCKET" ]]; then
  echo "Usage:"
  echo "  scripts/selfhost/redeploy-analyzer.sh <GCP_PROJECT_ID> <SUPABASE_URL> <GCS_BUCKET>"
  echo
  echo "Example:"
  echo "  scripts/selfhost/redeploy-analyzer.sh tcvstudio https://supabase.yourdomain.com your-video-analysis-bucket"
  exit 1
fi

echo "Setting gcloud project to: $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

echo "Submitting Cloud Build for analyzer redeploy..."
cd "${ROOT_DIR}/gcp-cloud-run"
gcloud builds submit --config cloudbuild.yaml \
  --substitutions="_GCS_BUCKET=${GCS_BUCKET},_SUPABASE_URL=${SUPABASE_URL},COMMIT_SHA=selfhost-$(date +%s)"

echo "Analyzer redeploy command submitted."
