
# Fix: Cloud Build Image Tag Error

## Problem
The `cloudbuild.yaml` uses `$COMMIT_SHA` as the image tag, but this variable is only automatically set when Cloud Build is triggered by a git repository (like GitHub/Cloud Source Repositories). When running `gcloud builds submit` manually, `$COMMIT_SHA` is empty, causing the invalid image name error.

## Solution
Add a custom `_TAG` substitution when running the build command manually.

---

## Quick Fix (Run This Now)

Run this single command from your `~/gcp-cloud-run/brainwave-studio-flow/gcp-cloud-run` directory:

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions="_GCS_BUCKET=tcvstudioanalyze,_SUPABASE_URL=https://hdytpmbgrhaxyjvvpewy.supabase.co,COMMIT_SHA=v1"
```

This provides a manual value (`v1`) for the `COMMIT_SHA` variable.

---

## What Happens Next
1. Docker builds the container image with tag `v1`
2. Image is pushed to Google Container Registry
3. Cloud Run service is deployed with the new image
4. Build takes approximately 3-5 minutes

---

## Possible Errors You Might Encounter

### Secret Not Found
If you see an error about `GCP_CALLBACK_SECRET` not existing, you'll need to create it first:
```bash
# Generate a random secret
openssl rand -base64 32 > /tmp/secret.txt

# Create the secret in Secret Manager
gcloud secrets create GCP_CALLBACK_SECRET --data-file=/tmp/secret.txt

# View the secret value (save this for your backend config)
cat /tmp/secret.txt
```

Then retry the build command.

### Cloud Run Service Account Permissions
If you see a permissions error during the Cloud Run deploy step, run:
```bash
PROJECT_NUMBER=$(gcloud projects describe tcvstudio --format="value(projectNumber)")
gcloud projects add-iam-policy-binding tcvstudio --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="roles/run.admin"
gcloud projects add-iam-policy-binding tcvstudio --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="roles/iam.serviceAccountUser"
```

---

## After Successful Deployment
Once the build completes successfully, we'll set up the **Eventarc trigger** to automatically invoke Cloud Run when new videos are uploaded to your GCS bucket.
