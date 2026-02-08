# GCP Video QC Pipeline Setup Guide

This guide walks you through setting up the Google Cloud Platform infrastructure for the TCV Video QC Pipeline.

## Prerequisites

- Google Cloud account with billing enabled
- `gcloud` CLI installed ([Install Guide](https://cloud.google.com/sdk/docs/install))
- Docker installed (for local testing)

---

## Phase 1: GCP Project Setup

### 1.1 Create or Select a Project

```bash
# Create a new project
gcloud projects create tcv-video-qc --name="TCV Video QC"

# Or use an existing project
gcloud config set project YOUR_PROJECT_ID
```

### 1.2 Enable Required APIs

```bash
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com \
  aiplatform.googleapis.com \
  eventarc.googleapis.com \
  secretmanager.googleapis.com
```

### 1.3 Set Default Region

```bash
gcloud config set run/region us-central1
gcloud config set eventarc/location us-central1
```

---

## Phase 2: Create Service Account

### 2.1 Create the Service Account

```bash
gcloud iam service-accounts create tcv-analyzer \
  --display-name="TCV Video Analyzer Service Account"
```

### 2.2 Grant Required Roles

```bash
PROJECT_ID=$(gcloud config get-value project)

# Cloud Run invoker (for Eventarc triggers)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# Storage object viewer (to download videos)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# Vertex AI user (for Gemini API)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Secret Manager accessor
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Phase 3: Cloud Storage Bucket

### 3.1 Create the Bucket

```bash
# Create bucket (replace with your unique name)
gsutil mb -l us-central1 gs://tcv-video-uploads-$PROJECT_ID

# Note: We recommend using 'tcvstudioanalyze' as the bucket name for the analyzer
```

### 3.2 Set Lifecycle Rule (Auto-cleanup after 24 hours)

To minimize storage costs, configure a lifecycle rule to automatically delete analyzed videos after 24 hours while preserving config files:

```bash
cat > /tmp/lifecycle.json << 'EOF'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {
        "age": 1,
        "matchesPrefix": ["uploads/"]
      }
    }
  ]
}
EOF

gsutil lifecycle set /tmp/lifecycle.json gs://tcvstudioanalyze
```

**Via Google Cloud Console (alternative):**
1. Go to **Cloud Storage** → **Buckets** → `tcvstudioanalyze`
2. Click **Lifecycle** tab
3. Click **Add a rule**
4. Configure:
   - **Action**: Delete object
   - **Condition**: Age = 1 day
   - **Object name prefix**: `uploads/` (only delete analyzed videos, not config files)
5. Click **Create**

### 3.3 Grant Service Account Access

```bash
gsutil iam ch \
  serviceAccount:tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com:objectViewer \
  gs://tcv-video-uploads-$PROJECT_ID

# Also grant write access for the config/feedback.json (Memory Layer)
gsutil iam ch \
  serviceAccount:tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com:objectCreator \
  gs://tcvstudioanalyze
```

---

## Phase 4: Secret Manager

### 4.1 Create the Callback Secret

```bash
# Generate a random secret
GCP_CALLBACK_SECRET=$(openssl rand -base64 32)

# Store in Secret Manager
echo -n "$GCP_CALLBACK_SECRET" | gcloud secrets create GCP_CALLBACK_SECRET \
  --data-file=-

# Note: Use this SAME secret in your Supabase project!
echo "Your GCP_CALLBACK_SECRET: $GCP_CALLBACK_SECRET"
echo "Add this to Supabase secrets as GCP_CALLBACK_SECRET"
```

---

## Phase 5: Deploy Cloud Run Service

### 5.1 Build and Deploy

From the project root directory:

```bash
cd gcp-cloud-run

# Build and push container
gcloud builds submit --config cloudbuild.yaml \
  --substitutions="_GCS_BUCKET=tcv-video-uploads-$PROJECT_ID,_SUPABASE_URL=https://hdytpmbgrhaxyjvvpewy.supabase.co"
```

### 5.2 Manual Deploy (Alternative)

If you prefer manual deployment:

```bash
# Build the container
docker build -t gcr.io/$PROJECT_ID/tcv-video-analyzer .

# Push to Container Registry
docker push gcr.io/$PROJECT_ID/tcv-video-analyzer

# Deploy to Cloud Run
gcloud run deploy tcv-video-analyzer \
  --image gcr.io/$PROJECT_ID/tcv-video-analyzer \
  --platform managed \
  --region us-central1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900 \
  --concurrency 1 \
  --max-instances 10 \
  --set-env-vars "GCS_BUCKET=tcv-video-uploads-$PROJECT_ID,SUPABASE_URL=https://hdytpmbgrhaxyjvvpewy.supabase.co" \
  --set-secrets "GCP_CALLBACK_SECRET=GCP_CALLBACK_SECRET:latest" \
  --service-account "tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated
```

---

## Phase 6: Create Eventarc Trigger

### 6.1 Grant Pub/Sub Publisher Role to Cloud Storage

```bash
# Get the Cloud Storage service account
GCS_SERVICE_ACCOUNT=$(gsutil kms serviceaccount -p $PROJECT_ID)

# Grant Pub/Sub publisher role
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$GCS_SERVICE_ACCOUNT" \
  --role="roles/pubsub.publisher"
```

### 6.2 Create the Trigger

```bash
# Get Cloud Run service URL
SERVICE_URL=$(gcloud run services describe tcv-video-analyzer \
  --region us-central1 \
  --format 'value(status.url)')

# Create Eventarc trigger for new file uploads
gcloud eventarc triggers create tcv-video-trigger \
  --location us-central1 \
  --destination-run-service tcv-video-analyzer \
  --destination-run-region us-central1 \
  --event-filters "type=google.cloud.storage.object.v1.finalized" \
  --event-filters "bucket=tcv-video-uploads-$PROJECT_ID" \
  --service-account "tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com"
```

---

## Phase 7: Configure CORS for Browser Uploads

### 7.1 Set CORS Policy

```bash
cat > /tmp/cors.json << 'EOF'
[
  {
    "origin": ["*"],
    "method": ["GET", "POST", "PUT", "DELETE", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Range"],
    "maxAgeSeconds": 3600
  }
]
EOF

gsutil cors set /tmp/cors.json gs://tcv-video-uploads-$PROJECT_ID
```

---

## Phase 8: Generate Signed URLs (For Direct Uploads)

To allow the frontend to upload directly to GCS, you'll need to generate signed URLs. Add this edge function to your Supabase project:

### 8.1 Create GCS Signed URL Generator Edge Function

See `supabase/functions/gcs-signed-url/index.ts` for the implementation.

### 8.2 Set Up Service Account Key

```bash
# Create a key for the service account
gcloud iam service-accounts keys create /tmp/tcv-analyzer-key.json \
  --iam-account tcv-analyzer@$PROJECT_ID.iam.gserviceaccount.com

# Base64 encode it for Supabase secret
cat /tmp/tcv-analyzer-key.json | base64 -w 0

# Add as Supabase secret: GCP_SERVICE_ACCOUNT_KEY
```

---

## Verification Checklist

- [ ] APIs enabled (Cloud Run, Storage, Vertex AI, Eventarc)
- [ ] Service account created with correct roles
- [ ] GCS bucket created with lifecycle policy
- [ ] GCP_CALLBACK_SECRET stored in Secret Manager
- [ ] Same GCP_CALLBACK_SECRET added to Supabase secrets
- [ ] Cloud Run service deployed and healthy
- [ ] Eventarc trigger created and active
- [ ] CORS configured on GCS bucket

---

## Testing

### Test Cloud Run Directly

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe tcv-video-analyzer \
  --region us-central1 \
  --format 'value(status.url)')

# Test health endpoint
curl $SERVICE_URL/health
```

### Test Full Pipeline

1. Upload a test video to GCS:
```bash
gsutil cp test-video.mp4 gs://tcv-video-uploads-$PROJECT_ID/uploads/test-123/test-video.mp4
```

2. Check Cloud Run logs:
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=tcv-video-analyzer" --limit 50
```

3. Verify the callback was received in Supabase logs

---

## Cost Optimization Tips

1. **Lifecycle Policy**: Auto-delete uploaded videos after 24 hours (config files in `/config` are preserved)
2. **Cloud Run Concurrency**: Set to 1 to process one video at a time
3. **Max Instances**: Limit to 10 to control costs
4. **Region**: Use `us-central1` for cheapest Vertex AI pricing
5. **Frame Extraction**: Quick mode uses 5 frames, Thorough uses up to 15
6. **Memory Layer**: Dismissed flags are synced to GCS to reduce repeat false positives

---

## Troubleshooting

### Common Issues

**Event not triggering Cloud Run:**
- Check Eventarc trigger is active: `gcloud eventarc triggers list`
- Verify Pub/Sub publisher role on GCS service account
- Check file path matches expected format: `uploads/{uploadId}/{filename}`

**Callback not reaching Supabase:**
- Verify GCP_CALLBACK_SECRET matches in both GCP and Supabase
- Check Cloud Run logs for HTTP errors
- Verify Supabase function is deployed

**Vertex AI errors:**
- Ensure service account has `aiplatform.user` role
- Check quota limits in GCP console
- Verify Vertex AI API is enabled

---

## Architecture Diagram

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Browser   │     │  GCS Bucket     │     │   Cloud Run      │
│   Upload    │ --> │  (Eventarc      │ --> │   (Python +      │
│             │     │   Trigger)      │     │   FFmpeg)        │
└─────────────┘     └─────────────────┘     └────────┬─────────┘
                                                     │
                              ┌──────────────────────┘
                              │
                              v
                    ┌─────────────────┐     ┌──────────────────┐
                    │   Vertex AI     │     │    Supabase      │
                    │   (Gemini)      │     │   (Callback)     │
                    └─────────────────┘     └──────────────────┘
```

---

## Next Steps

1. Update the frontend to upload to GCS instead of Supabase Storage
2. Add the GCS signed URL edge function
3. Test with a real video file
4. Monitor costs in GCP Console

---

## Memory Layer (Learning from Dismissed Flags)

The system includes a "Memory Layer" that learns from dismissed QC flags to reduce repeat false positives.

### How It Works

1. When editors dismiss QC flags in the UI, those dismissals are stored in `video_uploads.dismissed_flags`
2. The `sync-dismissed-flags` edge function aggregates these patterns and uploads to `gs://tcvstudioanalyze/config/feedback.json`
3. The Cloud Run worker reads this file and includes "Known Exceptions" in Gemini prompts
4. AI analysis then avoids flagging issues that have been repeatedly dismissed

### Syncing Dismissed Flags

**Manual sync (admin only):**
```bash
curl -X POST https://hdytpmbgrhaxyjvvpewy.supabase.co/functions/v1/sync-dismissed-flags \
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN"
```

**Scheduled sync (recommended):**
Set up a cron job to call the function daily:
```bash
# Example: Using Google Cloud Scheduler
gcloud scheduler jobs create http sync-dismissed-flags \
  --schedule="0 2 * * *" \
  --uri="https://hdytpmbgrhaxyjvvpewy.supabase.co/functions/v1/sync-dismissed-flags" \
  --http-method=POST \
  --headers="x-cron-secret=YOUR_CRON_SECRET" \
  --location=us-central1
```

### Role-Based AI Analysis

The system uses different AI personas based on analysis mode:

| Mode | Persona | Focus |
|------|---------|-------|
| Quick | QC Editor | Fast pass/fail, catches obvious errors only |
| Thorough | Senior Creative Director | Detailed analysis of technical + creative quality |
