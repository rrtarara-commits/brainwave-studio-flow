# Fix Cloud Run Timeout for Large Videos

## ✅ IMPLEMENTED

### Changes Made

#### 1. gcp-cloud-run/main.py - Async Processing Architecture
- Added `threading` and background job processing
- HTTP handler now returns **202 Accepted** immediately
- Video processing runs in a daemon background thread (`process_video_async`)
- Added job tracking with `processing_jobs` dictionary and thread lock
- Added `/job/<job_id>` endpoint to check job status
- Added `/startup` endpoint for startup probe

#### 2. gcp-cloud-run/cloudbuild.yaml - Startup Probe Configuration
- Added `--startup-cpu-boost` for faster cold starts
- Added startup probe: `/startup` with 10s period, 3 failure threshold
- Added liveness probe: `/health` with 30s period
- Increased concurrency from 1 to 10 (can handle multiple events while background threads process)
- Updated `_GCS_BUCKET` to correct value `tcvstudioanalyze`

#### 3. supabase/functions/video-qc/index.ts - Streaming GCS Upload
- Replaced memory-buffered `copyToGCS` with streaming `streamToGCS`
- Uses Supabase signed URLs to stream directly to GCS
- Never loads entire file into edge function memory
- Supports all video content types (mp4, mov, avi, mkv, etc.)

---

## Deployment Steps

1. **Edge function deploys automatically** with code changes

2. **Redeploy Cloud Run** from GCP Cloud Shell:
   ```bash
   cd gcp-cloud-run
   git pull origin main
   gcloud builds submit --substitutions=COMMIT_SHA=v7,_GCS_BUCKET=tcvstudioanalyze,_SUPABASE_URL=https://hdytpmbgrhaxyjvvpewy.supabase.co
   ```

---

## Architecture Summary

```
BEFORE (BLOCKING):
  GCS Event --> Cloud Run HTTP --> [Download + Process + Analyze] --> Response
                                   (2-10 minutes blocking, causes timeout)

AFTER (ASYNC):
  GCS Event --> Cloud Run HTTP --> Queue Job --> Response (immediate 202)
                                        |
                    Background Thread --+--> Download --> Process --> Callback
```

**Benefits:**
- Cloud Run responds in <1 second (no timeout)
- Container stays healthy during processing
- Streaming upload avoids 150MB edge function limit
- Startup/liveness probes ensure reliable health checks
