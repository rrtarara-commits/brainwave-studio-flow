# Self-Hosted Execution Runbook

Use this on branch `self-hosted-rebuild`.

## 0) Confirm branch

```bash
git checkout self-hosted-rebuild
git pull
```

## 1) Prepare local env files

```bash
npm run selfhost:bootstrap-env
```

## 2) Install Supabase self-host stack (TrueNAS host)

Run this on the machine that will host Supabase Docker (your TrueNAS apps shell):

```bash
cd /path/to/brainwave-studio-flow
npm run selfhost:install-stack -- "$HOME/supabase-selfhost"
```

Start Supabase stack:

```bash
cd "$HOME/supabase-selfhost"
docker compose pull
docker compose up -d
```

## 3) Import self-hosted Supabase keys into this app

From this repo:

```bash
npm run selfhost:print-values -- "$HOME/supabase-selfhost/.env"
npm run selfhost:apply-values -- "$HOME/supabase-selfhost/.env"
```

Edit:

- `.env`
- `supabase/functions/.env`

Then verify:

```bash
npm run selfhost:check-env
```

`selfhost:check-env` intentionally fails if placeholder values are still present.

## 4) Apply database migrations to self-hosted Postgres

```bash
npm run selfhost:migrate-db -- "postgresql://postgres:<password>@<db-host>:5432/postgres"
```

## 5) Build and test frontend

```bash
npm run lint
npm run test
npm run build
```

## 6) Push branch-safe changes

```bash
git push -u origin self-hosted-rebuild
```

## 7) Repoint Cloud Run analyzer to self-hosted Supabase

From this repo root:

```bash
scripts/selfhost/redeploy-analyzer.sh <GCP_PROJECT_ID> <SUPABASE_URL> <GCS_BUCKET>
```

Example:

```bash
scripts/selfhost/redeploy-analyzer.sh tcvstudio https://supabase.yourdomain.com your-video-analysis-bucket
```

Update GCP secrets first (recommended):

```bash
scripts/selfhost/sync-gcp-secrets.sh <GCP_PROJECT_ID>
```

## 8) Validate core QC flow

1. Login to app.
2. Upload test video.
3. Verify `video_uploads` row updates:
   - `status`: `pending` -> `analyzing` -> `reviewed`
   - `deep_analysis_status`: `pending` -> `processing` -> `complete` (or explicit `failed`)
4. Submit to Frame.io with selected notes.

## Notes

- `rebuild-analyzer` command assumes your GCP secrets already exist:
  - `GCP_CALLBACK_SECRET`
  - `SUPABASE_SERVICE_ROLE_KEY`
- If secrets changed, update them first in Secret Manager.
- `LOVABLE_API_KEY` is optional for baseline QC pipeline, but required for:
  - AI Brain
  - AI filename/metadata checks in `video-qc`
