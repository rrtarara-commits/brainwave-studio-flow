# Self-Hosting on TrueNAS

This guide is for the `self-hosted-rebuild` branch.

## Target Outcome

- No managed Supabase subscription required
- Same app behavior (auth, roles, QC uploads, Notion/Frame.io workflows)
- GCP analyzer worker can remain as-is (just repointed to your self-hosted Supabase URL)

## Recommended Topology

1. TrueNAS hosts Supabase OSS stack (Postgres/Auth/Storage/API/Functions).
2. Frontend uses your self-hosted URL + anon key.
3. Cloud Run worker posts analysis callbacks to your self-hosted functions endpoint.

## 1) Bring up Self-Hosted Supabase

Use the official Supabase self-hosted Docker stack on your TrueNAS Docker host. Keep these outputs handy:

- `SUPABASE_URL` (gateway URL)
- `ANON_KEY`
- `SERVICE_ROLE_KEY`
- Postgres connection string

## 2) Apply This App Schema

From this repo (with Supabase CLI installed), apply migrations to your self-hosted database:

```bash
supabase db push --db-url "postgresql://postgres:<DB_PASSWORD>@<DB_HOST>:5432/postgres"
```

## 3) Configure Frontend

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Set:

- `VITE_SUPABASE_URL=https://<your-supabase-domain>`
- `VITE_SUPABASE_PUBLISHABLE_KEY=<your-anon-key>`

Optional:

- `VITE_FUNCTIONS_BASE_URL=https://<your-functions-base>/functions/v1`
  - Use this only if your functions are hosted outside Supabase.

## 4) Configure Function Secrets

Set required secrets for features you use (see `supabase/functions/.env.example`).

Minimum for core QC:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LOVABLE_API_KEY`
- `GCS_BUCKET`
- `GCP_SERVICE_ACCOUNT_JSON`
- `GCP_CALLBACK_SECRET`

## 5) Point Cloud Run Worker to Self-Hosted Supabase

Update analyzer service env vars:

- `SUPABASE_URL=https://<your-supabase-domain>`
- `SUPABASE_SERVICE_ROLE_KEY=<service-role-key>`
- `GCS_BUCKET=<your-video-analysis-bucket>`
- `GCP_CALLBACK_SECRET=<shared-secret>`

Then redeploy Cloud Run.

## 6) Validate End-to-End

1. Sign in through the app.
2. Upload a test video.
3. Confirm row appears in `video_uploads`.
4. Confirm status transitions:
   - `pending` -> `analyzing` -> `reviewed`
   - `deep_analysis_status`: `pending` -> `processing` -> `complete` (or explicit `failed`)
5. Confirm Frame.io submit still works with selected QC comments.

## 7) Branch-Safe Release Flow

```bash
git checkout self-hosted-rebuild
npm run lint
npm run test
npm run build
git push -u origin self-hosted-rebuild
```

Deploy this branch separately from your existing production branch.
