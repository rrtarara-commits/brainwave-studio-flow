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

Edit:

- `.env`
- `supabase/functions/.env`

Then verify:

```bash
npm run selfhost:check-env
```

`selfhost:check-env` intentionally fails if placeholder values are still present.

## 2) Apply database migrations to self-hosted Postgres

```bash
npm run selfhost:migrate-db -- "postgresql://postgres:<password>@<db-host>:5432/postgres"
```

## 3) Build and test frontend

```bash
npm run lint
npm run test
npm run build
```

## 4) Push branch-safe changes

```bash
git push -u origin self-hosted-rebuild
```

## 5) Repoint Cloud Run analyzer to self-hosted Supabase

From this repo root:

```bash
scripts/selfhost/redeploy-analyzer.sh <GCP_PROJECT_ID> <SUPABASE_URL> <GCS_BUCKET>
```

Example:

```bash
scripts/selfhost/redeploy-analyzer.sh tcvstudio https://supabase.yourdomain.com your-video-analysis-bucket
```

## 6) Validate core QC flow

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
