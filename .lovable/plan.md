

## Accurate Deep Analysis Progress Bar

### The Challenge

Currently, the Cloud Run worker processes the video in a background thread and only reports back **once** — when everything is done. The frontend polls `deep_analysis_status` every 3 seconds but only sees `pending -> processing -> completed`, with no granularity in between. This means you can't show real progress today.

### The Solution

Add a `deep_analysis_progress` column to track percentage and current step, have the Cloud Run worker report progress at each processing stage, and update the frontend to display a real progress bar.

### Processing Stages and Weights

The Cloud Run pipeline has well-defined stages we can map to progress percentages:

```text
Stage                  | Weight | Cumulative
-----------------------|--------|----------
Downloading video      |   15%  |   15%
Extracting frames      |   15%  |   30%
Audio analysis         |   20%  |   50%
Black frame detection  |   10%  |   60%
Flash frame detection  |   10%  |   70%
Freeze frame detection |   10%  |   80%
AI visual analysis     |   15%  |   95%
Submitting results     |    5%  |  100%
```

(Quick mode skips black/flash/freeze detection, so weights redistribute accordingly.)

---

### Technical Details

**1. Database: Add progress tracking column**

Add a `deep_analysis_progress` JSONB column to `video_uploads`:
```sql
ALTER TABLE video_uploads 
ADD COLUMN deep_analysis_progress jsonb DEFAULT '{"percent": 0, "stage": "pending"}'::jsonb;
```

**2. Cloud Run Worker (`gcp-cloud-run/main.py`)**

Add a `report_progress(upload_id, percent, stage)` helper that PATCHes the `deep_analysis_progress` column via a direct Supabase REST API call (using the service role key already available). Call it at each stage boundary inside `process_video_async`:

- Before download: `report_progress(upload_id, 5, "Downloading video...")`
- After download: `report_progress(upload_id, 15, "Extracting frames...")`
- After frame extraction: `report_progress(upload_id, 30, "Analyzing audio...")`
- After audio: `report_progress(upload_id, 50, "Detecting black frames...")`
- After black frames: `report_progress(upload_id, 60, "Detecting flash frames...")`
- After flash frames: `report_progress(upload_id, 70, "Detecting freeze frames...")`
- After freeze frames: `report_progress(upload_id, 80, "Running AI visual analysis...")`
- After Gemini: `report_progress(upload_id, 95, "Submitting results...")`

**3. Frontend Polling (`src/hooks/useVideoUpload.ts`)**

- Include `deep_analysis_progress` in the polling query
- Expose the progress data (percent + stage label) from the hook

**4. UI (`src/components/video-upload/VideoUploadModal.tsx`)**

- Replace the current "Deep Analysis in Progress" spinner with a `<Progress>` bar showing the percentage
- Display the current stage label (e.g., "Analyzing audio...") below the bar
- Keep the spinner as a secondary indicator alongside the bar

**5. GCP Callback (`supabase/functions/gcp-analysis-callback/index.ts`)**

- Set `deep_analysis_progress` to `{"percent": 100, "stage": "Complete"}` when writing final results

### What This Looks Like

During deep analysis, instead of a generic spinner, users will see:

```text
Deep Analysis: 50%
[==============                ]
Analyzing audio...
```

The bar updates every 3 seconds (matching the existing poll interval), providing clear visibility into which step is running and roughly how far along the analysis is.

