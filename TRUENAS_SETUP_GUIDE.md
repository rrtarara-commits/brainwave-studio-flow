# TrueNAS Deep Video Analyzer - Complete Setup Guide

This guide walks you through setting up the video analysis system on TrueNAS SCALE, even if you've never worked with servers before.

---

## 📋 What You'll Need Before Starting

1. **TrueNAS SCALE** installed and accessible via web browser
2. **A Gemini API Key** (free) - we'll get this in Step 2
3. **Your TRUENAS_CALLBACK_SECRET** - you already added this to Lovable Cloud
4. About **30 minutes** of time

---

## Step 1: Download the Required Files

You need to get 4 files from your Lovable project onto your computer first:

### Option A: Copy from Lovable (Recommended)

1. In Lovable, click the **"Code"** button in the top-left to view your code
2. Find and open each of these files:
   - `truenas-analyzer.py`
   - `truenas-analyzer-Dockerfile`
   - `truenas-docker-compose.yml`
   - `setup-analyzer.sh`
3. For each file, select all the code (Ctrl+A or Cmd+A) and copy it
4. On your computer, create a folder called `video-analyzer`
5. Create each file and paste the contents

### Option B: Download from GitHub
If your project is connected to GitHub, you can clone it and find the files there.

---

## Step 2: Get Your Free Gemini API Key

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Select **"Create API key in new project"**
5. Copy the key that appears (it starts with `AIza...`)
6. **Save this somewhere safe** - you'll need it in Step 5

---

## Step 3: Access TrueNAS SCALE

1. Open your web browser
2. Go to your TrueNAS IP address (something like `http://192.168.1.100`)
3. Log in with your TrueNAS admin account

---

## Step 4: Create a Dataset for the Analyzer

We need a place to store the analyzer files:

1. In TrueNAS, go to **Storage** in the left sidebar
2. Click on your main pool (usually called "tank" or similar)
3. Click **"Add Dataset"**
4. Name it: `video-analyzer`
5. Leave all other settings as default
6. Click **"Save"**

---

## Step 5: Upload Your Files to TrueNAS

### Using the TrueNAS File Browser:

1. Go to **System Settings → Shell** (or use SSH if you prefer)
2. Navigate to your dataset:
   ```bash
   cd /mnt/YOUR_POOL_NAME/video-analyzer
   ```
   (Replace `YOUR_POOL_NAME` with your actual pool name, like `tank`)

3. Create each file using nano (a simple text editor):

   **File 1: truenas-analyzer.py**
   ```bash
   nano truenas-analyzer.py
   ```
   - Paste the entire contents of `truenas-analyzer.py`
   - Press `Ctrl+X`, then `Y`, then `Enter` to save

   **File 2: truenas-analyzer-Dockerfile**
   ```bash
   nano truenas-analyzer-Dockerfile
   ```
   - Paste the contents
   - Press `Ctrl+X`, then `Y`, then `Enter` to save

   **File 3: truenas-docker-compose.yml**
   ```bash
   nano truenas-docker-compose.yml
   ```
   - Paste the contents
   - Press `Ctrl+X`, then `Y`, then `Enter` to save

   **File 4: Create the .env file with your secrets**
   ```bash
   nano .env
   ```
   - Type exactly this (replacing the placeholder values):
   ```
   TRUENAS_CALLBACK_SECRET=paste_your_secret_here
   GEMINI_API_KEY=paste_your_gemini_key_here
   ```
   - Press `Ctrl+X`, then `Y`, then `Enter` to save

### Alternative: Use SFTP/SCP
If you have an SFTP client like FileZilla:
1. Connect to TrueNAS using SFTP (port 22)
2. Navigate to `/mnt/YOUR_POOL_NAME/video-analyzer/`
3. Upload all 4 files
4. Create the `.env` file with your secrets

---

## Step 6: Build and Start the Docker Container

1. In the TrueNAS Shell, make sure you're in the right folder:
   ```bash
   cd /mnt/YOUR_POOL_NAME/video-analyzer
   ```

2. Build the Docker image:
   ```bash
   docker-compose -f truenas-docker-compose.yml build
   ```
   
   **This will take 2-5 minutes.** You'll see it downloading and installing things.

3. Start the analyzer:
   ```bash
   docker-compose -f truenas-docker-compose.yml up -d
   ```
   
   The `-d` means it runs in the background.

4. Check that it's running:
   ```bash
   docker-compose -f truenas-docker-compose.yml ps
   ```
   
   You should see `tcv-deep-analyzer` with status `Up`.

---

## Step 7: Verify It's Working

1. Check the logs to see if it's connecting:
   ```bash
   docker-compose -f truenas-docker-compose.yml logs -f
   ```

2. You should see something like:
   ```
   Configuration validated successfully
   Starting deep analysis service (polling every 15s)
   Polled - Found 0 pending uploads
   ```

3. Press `Ctrl+C` to stop watching the logs (the analyzer keeps running)

---

## 🎉 Done! How It Works Now

Every 15 seconds, your TrueNAS server will:
1. Check if any videos need deep analysis
2. Download and analyze them automatically
3. Send the results back to your app

When you upload a video in your app, within about 15-30 seconds the deep analysis will begin!

---

## Common Commands You'll Need

### View what's happening:
```bash
docker-compose -f truenas-docker-compose.yml logs -f
```
(Press Ctrl+C to exit)

### Stop the analyzer:
```bash
docker-compose -f truenas-docker-compose.yml down
```

### Restart the analyzer:
```bash
docker-compose -f truenas-docker-compose.yml restart
```

### Update after code changes:
```bash
docker-compose -f truenas-docker-compose.yml down
docker-compose -f truenas-docker-compose.yml build
docker-compose -f truenas-docker-compose.yml up -d
```

---

## Troubleshooting

### "Permission denied" errors
```bash
chmod +x truenas-analyzer.py
chmod 600 .env
```

### "Cannot connect" or authentication errors
- Double-check your `TRUENAS_CALLBACK_SECRET` matches exactly what's in Lovable Cloud
- Make sure there are no extra spaces in your `.env` file

### "docker-compose not found"
On TrueNAS SCALE, you might need to use:
```bash
docker compose -f truenas-docker-compose.yml up -d
```
(Note: `docker compose` with a space, not `docker-compose` with a hyphen)

### Container keeps restarting
Check the logs for errors:
```bash
docker-compose -f truenas-docker-compose.yml logs --tail 50
```

### Need to change your API keys
1. Edit the `.env` file: `nano .env`
2. Update the values
3. Restart: `docker-compose -f truenas-docker-compose.yml restart`

---

## Understanding the .env File

Your `.env` file contains two secret values:

```
TRUENAS_CALLBACK_SECRET=abc123xyz...
GEMINI_API_KEY=AIzaSy...
```

| Variable | What it is | Where to get it |
|----------|-----------|-----------------|
| `TRUENAS_CALLBACK_SECRET` | Password for TrueNAS to talk to your app | You created this in Lovable Cloud → Secrets |
| `GEMINI_API_KEY` | Your Google AI key for visual analysis | https://aistudio.google.com/apikey |

**Keep these secret!** Don't share them or commit them to git.

---

## Need Help?

If you get stuck:
1. Copy the exact error message you're seeing
2. Note which step you're on
3. Share this info when asking for help

The most common issues are typos in the `.env` file or the secret not matching what's in Lovable Cloud.
