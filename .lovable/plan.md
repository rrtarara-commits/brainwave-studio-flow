
Goal
- Resolve the Cloud Shell error “You do not currently have an active account selected” so you can run `gcloud builds submit` (Cloud Build -> deploy to Cloud Run) successfully.

What’s happening
- Your Cloud Shell session has a project selected (`tcvstudio`), but no active authenticated user account is selected for `gcloud`, so Cloud Build submission is blocked.

Step-by-step fix (copy/paste)

1) Confirm whether any account is logged in
```bash
gcloud auth list
gcloud config list account
```
Expected:
- If you see “No credentialed accounts.” OR the “ACTIVE” column is empty, proceed to step 2.
- If you see an account but it’s not ACTIVE, jump to step 3.

2) Log in (creates credentials)
```bash
gcloud auth login
```
- Cloud Shell usually opens a browser-based login flow (or prints a link + code).
- After login, re-check:
```bash
gcloud auth list
```

3) Select the active account explicitly (only needed if you have multiple accounts or none is active)
- From the `gcloud auth list` output, copy the email you want to use, then:
```bash
gcloud config set account YOUR_EMAIL_ADDRESS
```
Verify:
```bash
gcloud config list account
gcloud auth list
```
Expected:
- Your email shows as the active account.

4) Re-confirm project (quick sanity check)
```bash
gcloud config set project tcvstudio
gcloud config list project
```

5) Re-run the build submit (avoid backslash issues by using a single line)
Run this from the folder that contains `cloudbuild.yaml`:
```bash
gcloud builds submit --config cloudbuild.yaml --substitutions="_GCS_BUCKET=tcvstudioanalyze,_SUPABASE_URL=YOUR_BACKEND_URL"
```
Notes:
- Use the exact backend URL you were already using earlier (keep it unchanged).
- This will build the image, push it, then deploy to Cloud Run per `cloudbuild.yaml`.

6) Watch logs (optional but helpful)
```bash
gcloud builds list --limit=5
# then (pick the most recent BUILD_ID)
gcloud builds log --stream BUILD_ID
```

Common next errors (so you’re not blocked later)

A) APIs not enabled
If you get errors about missing APIs, run:
```bash
gcloud services enable cloudbuild.googleapis.com run.googleapis.com secretmanager.googleapis.com storage.googleapis.com
```
Then retry the build.

B) Cloud Build service account lacks permission to deploy to Cloud Run
If you see a permission error mentioning `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`, fix with:
```bash
PROJECT_ID=tcvstudio
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/iam.serviceAccountUser"
```
Then retry the build submit.

C) Secret not found (GCP_CALLBACK_SECRET)
If deployment fails saying the secret doesn’t exist, confirm/create it:
```bash
gcloud secrets describe GCP_CALLBACK_SECRET
```
If it’s missing, you’ll need to create it (and use the same value later in your backend config).

What I need from you (to confirm we’re unblocked)
- Paste the output of:
  1) `gcloud auth list`
  2) If you still get an error after retrying: the exact Cloud Build error text (last ~20 lines).
