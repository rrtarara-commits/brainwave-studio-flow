## TrueNAS Deep Analysis Integration

### Architecture
The deep analysis system uses an outbound polling architecture to bypass Edge Function memory constraints:

1. **Video Upload Flow**: When a video is uploaded and passes initial QC, it's marked with `deep_analysis_status: 'pending'`
2. **TrueNAS Polling**: The TrueNAS server polls `deep-analysis-poll` endpoint every minute
3. **Video Download**: TrueNAS downloads videos via signed URLs, processes with FFmpeg + Gemini Vision
4. **Results Callback**: Analysis results are POSTed to `deep-analysis-callback` endpoint

### Edge Functions

- `deep-analysis-poll`: Returns pending uploads with signed URLs (authenticated via `TRUENAS_CALLBACK_SECRET`)
- `deep-analysis-callback`: Receives analysis results and merges into QC flags

### Database Columns (video_uploads)

- `deep_analysis_status`: 'none' | 'pending' | 'processing' | 'completed' | 'failed'
- `visual_analysis`: JSON with frames analyzed, detected issues
- `audio_analysis`: JSON with dialogue levels, peak detection, issues
- `signed_url` / `signed_url_expires_at`: Temporary download URLs

### TrueNAS Docker Setup

Create a Python container that:
1. Polls `/functions/v1/deep-analysis-poll` with header `x-truenas-secret: YOUR_SECRET`
2. Downloads videos via signed URLs
3. Runs FFmpeg for frame extraction + audio analysis
4. Calls Gemini Vision API for visual QC (glitches, artifacts, black frames)
5. POSTs results to `/functions/v1/deep-analysis-callback`

### Environment Variables for TrueNAS Container

```
SUPABASE_URL=https://hdytpmbgrhaxyjvvpewy.supabase.co
TRUENAS_CALLBACK_SECRET=your_secret_here
GEMINI_API_KEY=your_gemini_key
POLL_INTERVAL=60
```

