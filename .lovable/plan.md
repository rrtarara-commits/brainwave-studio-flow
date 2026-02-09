

# Fix Cloud Run Timeout for Large Videos

## Problem Diagnosis

Your Cloud Run service is failing with a "container failed to start" error when processing 10-minute videos. The root cause is architectural:

**The Issue**: The current design processes the video **synchronously within the HTTP request handler**. When a GCS event triggers the Cloud Run service:

1. Flask receives the request
2. The video is downloaded (can take 30-60+ seconds for large files)
3. FFmpeg analysis runs (can take 2-5+ minutes for 10-minute videos)
4. Gemini AI analysis runs (30-60+ seconds)
5. Only then does the HTTP response return

Cloud Run has startup and request timeouts. Even with a 900-second timeout configured, the **container must start and respond to health checks first**. If the first request to the container starts heavy processing immediately, the container may appear unresponsive and get terminated.

Additionally, the edge function logs show **"Memory limit exceeded"** - the video download into memory before GCS upload is hitting the 150MB edge function limit.

---

## Proposed Solution: Async Queue-Based Architecture

Implement a two-phase approach where the HTTP handler acknowledges events immediately and processing happens in the background.

### Architecture Change

```text
CURRENT (BLOCKING):
  GCS Event --> Cloud Run HTTP --> [Download + Process + Analyze] --> Response
                                   (2-10 minutes blocking)

PROPOSED (ASYNC):
  GCS Event --> Cloud Run HTTP --> Queue Job --> Response (immediate)
                                        |
                    Background Thread --+--> Download --> Process --> Callback
```

---

## Implementation Steps

### Step 1: Add Background Processing with Threading

Modify `main.py` to:
- Accept the GCS event and immediately return HTTP 202 (Accepted)
- Spawn a background thread to handle the actual video processing
- The background thread downloads, analyzes, and submits results

This ensures Cloud Run sees a healthy, responsive container while heavy work happens in the background.

### Step 2: Add Startup Health Check Improvements

Add explicit startup probe handling to ensure the container is marked healthy before any events are processed:
- Add a dedicated `/startup` endpoint
- Configure Cloud Run to use startup probe

### Step 3: Fix Edge Function Memory Issue

The video-qc edge function is hitting the 150MB memory limit when downloading large videos before uploading to GCS. Implement streaming upload instead of loading the entire file into memory.

### Step 4: Add Proxy Transcoding for Large Files (Optional Enhancement)

For files over 500MB, create a 720p proxy before running analysis. This reduces:
- Download time
- FFmpeg processing time
- Memory usage
- Overall costs

---

## Technical Details

### Cloud Run main.py Changes

```python
import threading

# Job queue for background processing
processing_jobs = {}

@app.route('/', methods=['POST'])
def handle_gcs_event():
    # Parse event and validate (same as before)
    ...
    
    # Start background processing
    job_id = str(uuid.uuid4())
    thread = threading.Thread(
        target=process_video_async,
        args=(bucket_name, blob_name, upload_id, mode, job_id)
    )
    thread.start()
    
    # Return immediately - don't wait for processing
    return jsonify({
        'accepted': True,
        'jobId': job_id,
        'uploadId': upload_id,
        'message': 'Video queued for analysis'
    }), 202  # HTTP 202 Accepted

def process_video_async(bucket_name, blob_name, upload_id, mode, job_id):
    """Background video processing - runs in separate thread."""
    try:
        # All the existing processing logic moves here
        with tempfile.TemporaryDirectory() as temp_dir:
            video_path = download_video(bucket_name, blob_name, temp_dir)
            # ... rest of analysis
            submit_results(upload_id, visual_analysis, audio_analysis)
    except Exception as e:
        submit_results(upload_id, {'issues': []}, {'issues': []}, success=False)
```

### Edge Function Streaming Fix

Replace the current "download entire file to memory" approach with a streaming copy that doesn't buffer the whole file:

```typescript
// Use signed URLs for direct GCS upload instead of buffering
async function streamToGCS(storagePath: string, uploadId: string, fileName: string) {
  // Get Supabase signed URL for the file
  const { data: signedUrl } = await serviceClient.storage
    .from('video-uploads')
    .createSignedUrl(storagePath, 3600);
  
  // Upload directly from URL to GCS using resumable upload
  // This avoids loading the file into edge function memory
}
```

### Cloudbuild.yaml Updates

Add startup probe configuration:

```yaml
- '--startup-cpu-boost'
- '--startup-probe-path=/health'
- '--startup-probe-initial-delay=0'
- '--startup-probe-period=10'
- '--startup-probe-failure-threshold=3'
```

---

## Benefits

1. **Immediate Response**: Cloud Run responds in <1 second, no timeout issues
2. **Reliable Processing**: Long videos process in background without blocking
3. **Memory Safe**: Streaming prevents edge function memory exhaustion
4. **Cost Efficient**: Container stays responsive, no wasted restarts
5. **Scalable**: Can handle multiple concurrent video uploads

---

## Files to Modify

1. **gcp-cloud-run/main.py** - Add threading and async processing
2. **gcp-cloud-run/cloudbuild.yaml** - Add startup probe configuration
3. **supabase/functions/video-qc/index.ts** - Implement streaming GCS upload

---

## Deployment Steps

After code changes:
1. Deploy the updated edge function (automatic)
2. Redeploy Cloud Run from GCP Cloud Shell:
   ```bash
   cd gcp-cloud-run
   gcloud builds submit --substitutions=COMMIT_SHA=v7,...
   ```

