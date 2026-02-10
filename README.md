# Brainwave Studio Flow

This branch (`self-hosted-rebuild`) is configured for **self-hosting**.

The app remains functionally the same, but infra assumptions are now branch-safe:
- no hardcoded hosted Supabase project URLs
- no tracked runtime `.env` file
- optional custom function backend URL (`VITE_FUNCTIONS_BASE_URL`)

## What This App Does

- Authenticated production workspace for video projects
- QC upload pipeline with:
  - initial QC analysis
  - deep analysis progress polling
  - pass/fail + flagged issues
- Optional handoff to Frame.io with timestamped QC comments
- Notion sync/push utilities for project metadata workflows

## Architecture (Current)

- Frontend: Vite + React + TypeScript
- Data/Auth/Storage: Supabase APIs (self-hostable)
- Server logic: Edge Functions in `supabase/functions/*`
- Deep media analysis worker: `gcp-cloud-run/main.py`

## Quick Start (Local)

1. Install dependencies:

```bash
npm install
```

2. Create local env:

```bash
npm run selfhost:bootstrap-env
```

3. Fill `.env` values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- optional: `VITE_FUNCTIONS_BASE_URL`

4. Run frontend:

```bash
npm run dev
```

## Self-Hosting Strategy

Recommended for your use case:

1. Self-host Supabase OSS (Auth, Postgres, Storage, API) on your TrueNAS host.
2. Deploy this app against that self-hosted URL and anon key.
3. Keep heavy video analysis on GCP Cloud Run (or migrate that worker later).

This gives you the best tradeoff: no managed Supabase subscription while preserving current app behavior.

Fast-path scripts:

```bash
npm run selfhost:install-stack -- "$HOME/supabase-selfhost"
npm run selfhost:print-values -- "$HOME/supabase-selfhost/.env"
npm run selfhost:apply-values -- "$HOME/supabase-selfhost/.env"
npm run selfhost:check-env
```

## Backend Function Routing

Frontend function calls now use a shared adapter:

- File: `src/lib/api/invoke-backend-function.ts`
- Default mode: calls `supabase.functions.invoke(...)`
- Optional override: if `VITE_FUNCTIONS_BASE_URL` is set, calls your custom function base URL directly

This lets you move function execution off Supabase incrementally without rewriting UI flows.

## Required Secrets / Env (Functions)

Depending on enabled features:

- Supabase core:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
- Notion:
  - `NOTION_API_KEY`
- Frame.io:
  - `FRAMEIO_CLIENT_ID`
  - `FRAMEIO_CLIENT_SECRET`
- AI/QC:
  - `GCP_SERVICE_ACCOUNT_JSON`
  - optional overrides:
    - `VERTEX_PROJECT_ID`
    - `VERTEX_LOCATION`
    - `VERTEX_MODEL`
- GCP integration:
  - `GCS_BUCKET`
  - `GCP_CALLBACK_SECRET`
- Optional cron:
  - `CRON_SECRET`

## Database

Schema and policies are in `supabase/migrations/*`.

For a clean self-hosted environment, apply all migrations in order.

## Quality Gates

Before pushing/deploying this branch:

```bash
npm run selfhost:check-env
npm run lint
npm run test
npm run build
```

## Related Docs

- `GCP_SETUP_GUIDE.md`: Cloud Run worker + Eventarc + callback flow
- `SELF_HOSTING_TRUENAS.md`: TrueNAS-oriented deployment model
- `SELF_HOSTING_RUNBOOK.md`: exact execution order and commands
