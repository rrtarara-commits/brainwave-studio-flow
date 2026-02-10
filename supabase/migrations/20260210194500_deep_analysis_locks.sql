-- Idempotency guard for GCS/Eventarc at-least-once delivery.
-- Cloud Run inserts one row per upload_id; duplicates will conflict and can be skipped.

CREATE TABLE IF NOT EXISTS public.deep_analysis_locks (
  upload_id uuid PRIMARY KEY,
  gcs_bucket text NOT NULL,
  gcs_object text NOT NULL,
  gcs_generation text,
  job_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Prevent anon/authenticated clients from writing locks (service role bypasses RLS).
ALTER TABLE public.deep_analysis_locks ENABLE ROW LEVEL SECURITY;

