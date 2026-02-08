

# GCP Cloud-Based QC Pipeline

## Overview

This plan replaces the self-hosted TrueNAS polling architecture with a fully managed Google Cloud Platform solution. The new architecture is **event-driven** (push-based) rather than polling-based, making it more responsive and cost-efficient.

---

## Architecture Comparison

### Current (TrueNAS - Polling)
```text
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Video       │ --> │ Supabase        │ <-- │ TrueNAS Server   │
│  Upload      │     │ Storage/DB      │     │ (polls every 15s)│
└──────────────┘     └─────────────────┘     └──────────────────┘
                            │                        │
                            │    poll for pending    │
                            │ <──────────────────────│
                            │    return video URLs   │
                            │ ──────────────────────>│
                            │                        │
                            │    (download, analyze) │
                            │                        │
                            │    submit results      │
                            │ <──────────────────────│
                            └────────────────────────┘
```

### Proposed (GCP - Event-Driven)
```text
┌──────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Video       │ --> │ Google Cloud    │ --> │ Cloud Run        │
│  Upload      │     │ Storage (GCS)   │     │ (auto-triggered) │
└──────────────┘     └─────────────────┘     └──────────────────┘
        │                                           │
        │                                    ┌──────┴──────┐
        │                                    │   FFmpeg    │
        │                                    │   Gemini    │
        │                                    │   (Vertex)  │
        │                                    └──────┬──────┘
        v                                           │
┌──────────────────┐                               │
│ Supabase DB      │ <─────── results ─────────────┘
│ (stores results) │
└──────────────────┘
```

---

## Benefits of the GCP Approach

| Aspect | TrueNAS (Current) | GCP Cloud Run (Proposed) |
|--------|-------------------|--------------------------|
| **Setup Difficulty** | Hard - requires Docker, networking, NAS configuration | Moderate - GCP console wizards, no hardware |
| **Cost Model** | Fixed (always running) | Pay-per-use (only when processing) |
| **Scaling** | Manual | Automatic (handles bursts) |
| **Latency** | 15-60 second delay (polling) | Near-instant (event trigger) |
| **Maintenance** | You maintain server | Google maintains infrastructure |
| **Reliability** | Depends on NAS uptime | 99.95% SLA |

---

## Implementation Steps

### Phase 1: GCP Project Setup

**What you'll do in Google Cloud Console:**

1. Create a new GCP project (or use existing)
2. Enable these APIs:
   - Cloud Storage
   - Cloud Run
   - Vertex AI
   - Video Intelligence API (optional)
3. Create a service account with roles:
   - Storage Object Viewer
   - Cloud Run Invoker
   - Vertex AI User

---

### Phase 2: Cloud Storage Bucket

**Create a GCS bucket for video uploads:**

1. Create bucket (e.g., `tcv-video-uploads`)
2. Set up lifecycle rules (auto-delete after 7 days to save costs)
3. Configure Eventarc trigger to call Cloud Run on new files

---

### Phase 3: Cloud Run Service

**Deploy a containerized Python service:**

The Cloud Run container will:

1. **Receive the GCS event** with the file path
2. **Download the video** from GCS to temp storage
3. **Run technical checks** (FFmpeg):
   - Audio levels (dialogue should average -3dB)
   - Peak detection (flag anything above -0.5dB)
   - Black frame detection
   - Audio dropout detection
4. **Send frames to Vertex AI** (Gemini):
   - Extract 5-10 keyframes
   - Analyze for visual issues (glitches, color problems, artifacts)
5. **POST results** to a new Supabase edge function
6. **Clean up** temp files

---

### Phase 4: Supabase Edge Function Changes

**Modifications needed:**

1. **New edge function: `gcp-analysis-callback`**
   - Similar to current `deep-analysis-callback`
   - Authenticated via a GCP service account token or shared secret
   - Merges visual/audio analysis into `qc_result`

2. **Update `video-qc` function:**
   - Instead of setting `deep_analysis_status: 'pending'`
   - Upload a copy of the video to GCS bucket
   - GCS trigger automatically starts Cloud Run

3. **Remove TrueNAS functions** (optional, keep as fallback):
   - `deep-analysis-poll`
   - `deep-analysis-callback`

---

### Phase 5: Frontend Upload Flow Change

**Current flow:**
1. Upload video to Supabase Storage
2. Run lightweight QC
3. Set `deep_analysis_status: 'pending'`
4. Wait for TrueNAS to poll and process

**New flow:**
1. Upload video directly to GCS bucket
2. GCS trigger fires → Cloud Run starts automatically
3. Cloud Run downloads, analyzes, POSTs results
4. Supabase receives results within seconds

---

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `gcp-cloud-run/Dockerfile` | Container with Python + FFmpeg |
| `gcp-cloud-run/main.py` | Cloud Run handler (receives events, runs analysis) |
| `gcp-cloud-run/requirements.txt` | Python dependencies |
| `gcp-cloud-run/cloudbuild.yaml` | Auto-deploy config |
| `supabase/functions/gcp-analysis-callback/index.ts` | Receives results from Cloud Run |
| `GCP_SETUP_GUIDE.md` | Step-by-step setup instructions |

### Modified Files

| File | Changes |
|------|---------|
| `src/hooks/useVideoUpload.ts` | Upload to GCS instead of Supabase Storage |
| `supabase/functions/video-qc/index.ts` | Remove TrueNAS queueing, add GCS upload trigger |

### Deletable Files (Optional)

| File | Reason |
|------|--------|
| `truenas-analyzer.py` | Replaced by Cloud Run |
| `truenas-docker-compose.yml` | No longer needed |
| `truenas-analyzer-Dockerfile` | No longer needed |
| `setup-analyzer.sh` | No longer needed |
| `TRUENAS_SETUP_GUIDE.md` | Replaced by GCP guide |
| `supabase/functions/deep-analysis-poll/` | Polling not needed |
| `supabase/functions/deep-analysis-callback/` | Replaced by gcp-analysis-callback |

---

## Cloud Run Python Code Overview

The main analysis logic stays very similar to `truenas-analyzer.py`, but packaged for Cloud Run:

```text
main.py
├── receive_event()          # Handle GCS trigger event
├── download_video()         # Download from GCS
├── extract_frames()         # FFmpeg frame extraction
├── analyze_audio()          # FFmpeg volumedetect
├── analyze_with_gemini()    # Vertex AI visual analysis
├── submit_results()         # POST to Supabase
└── cleanup()                # Delete temp files
```

---

## Environment Variables Needed

### Cloud Run Service

| Variable | Description |
|----------|-------------|
| `GCS_BUCKET` | Name of the upload bucket |
| `SUPABASE_URL` | Your Supabase project URL |
| `GCP_CALLBACK_SECRET` | Shared secret for callback auth |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID (auto-set in Cloud Run) |

### Supabase Secrets

| Variable | Description |
|----------|-------------|
| `GCP_CALLBACK_SECRET` | Matches the Cloud Run secret |

---

## Video Intelligence API (Optional Add-on)

For precision tasks where Gemini might struggle:

| Task | Tool |
|------|------|
| "Is the vibe happy?" | Gemini |
| "Does disclaimer appear at 00:05?" | Video Intelligence API |
| "Is the logo in frame?" | Video Intelligence API (Logo Detection) |
| "What text is on screen?" | Video Intelligence API (OCR) |

This can be added later as a Phase 6 enhancement.

---

## Cost Estimate

| Component | Estimated Monthly Cost |
|-----------|----------------------|
| Cloud Storage (10GB) | ~$0.20 |
| Cloud Run (100 videos/month, 2 min each) | ~$3-5 |
| Vertex AI (Gemini calls) | ~$5-10 |
| Video Intelligence API (optional) | ~$2-5 per 100 videos |
| **Total** | **~$10-20/month** |

Much cheaper than running a NAS 24/7, and scales automatically!

---

## Technical Details

### GCS Event Payload Example

When a file lands in the bucket, Cloud Run receives:

```text
{
  "kind": "storage#object",
  "bucket": "tcv-video-uploads",
  "name": "uploads/abc123/video.mp4",
  "contentType": "video/mp4",
  "size": "157286400"
}
```

### Callback Payload to Supabase

Same structure as current TrueNAS callback:

```text
{
  "uploadId": "uuid-here",
  "success": true,
  "visualAnalysis": {
    "framesAnalyzed": 10,
    "issues": [...],
    "summary": "..."
  },
  "audioAnalysis": {
    "averageDialogueDb": -4.2,
    "peakDb": -1.5,
    "issues": [...],
    "summary": "..."
  }
}
```

---

## Summary

This GCP approach is:

- **Easier to set up** than TrueNAS (no server configuration)
- **More reliable** (managed infrastructure with SLAs)
- **Cheaper** for low-to-moderate volume (pay per use)
- **Faster** (event-driven, no polling delay)
- **Scalable** (handles traffic spikes automatically)

The core analysis logic (FFmpeg + Gemini) remains the same - we're just changing where it runs and how it's triggered.

