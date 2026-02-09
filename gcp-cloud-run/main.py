"""
TCV Video QC Analyzer - Cloud Run Service
Event-driven video analysis pipeline using FFmpeg and Vertex AI (Gemini)
Supports Quick (fast) and Thorough (comprehensive) analysis modes

Architecture: Async processing with immediate HTTP response.
GCS events trigger immediate 202 Accepted, processing runs in background thread.
"""

import os
import re
import json
import base64
import tempfile
import subprocess
import threading
import uuid
import requests
from flask import Flask, request, jsonify
from google.cloud import storage
import vertexai
from vertexai.generative_models import GenerativeModel, Part

app = Flask(__name__)

# Configuration
GCS_BUCKET = os.environ.get('GCS_BUCKET', 'tcv-video-uploads')
SUPABASE_URL = os.environ.get('SUPABASE_URL')
# Strip whitespace/newlines from secret to prevent header errors
GCP_CALLBACK_SECRET = (os.environ.get('GCP_CALLBACK_SECRET') or '').strip()
PROJECT_ID = os.environ.get('GOOGLE_CLOUD_PROJECT')

# Audio analysis thresholds
DIALOGUE_TARGET_DB = -3.0
DIALOGUE_TOLERANCE_DB = 3.0
PEAK_ERROR_THRESHOLD_DB = -0.5
PEAK_WARNING_THRESHOLD_DB = -1.0

# Analysis mode settings - frames distributed across ENTIRE video
QUICK_MODE_FRAMES = 8  # More frames for better coverage
THOROUGH_MODE_FRAMES = 20  # Increased for full video analysis
SCENE_CHANGE_THRESHOLD = 0.3  # Lower = more sensitive

# Job tracking for background processing
processing_jobs = {}
jobs_lock = threading.Lock()

# Initialize Vertex AI
vertexai.init(project=PROJECT_ID, location="us-central1")


def download_video(bucket_name: str, blob_name: str, temp_dir: str) -> str:
    """Download video from GCS to local temp storage."""
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    
    local_path = os.path.join(temp_dir, os.path.basename(blob_name))
    blob.download_to_filename(local_path)
    
    print(f"Downloaded {blob_name} to {local_path}")
    return local_path


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds."""
    duration_cmd = [
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        video_path
    ]
    
    try:
        result = subprocess.run(duration_cmd, capture_output=True, text=True, timeout=60)
        return float(result.stdout.strip())
    except (subprocess.TimeoutExpired, ValueError):
        return 60.0  # Default to 60 seconds if detection fails


def detect_scene_changes(video_path: str, threshold: float = 0.3) -> list[float]:
    """Detect scene change timestamps using FFmpeg."""
    cmd = [
        'ffmpeg', '-i', video_path,
        '-vf', f'select=\'gt(scene,{threshold})\',showinfo',
        '-f', 'null', '-'
    ]
    
    scene_timestamps = []
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        stderr = result.stderr
        
        # Parse timestamps from showinfo output
        for line in stderr.split('\n'):
            if 'pts_time:' in line:
                try:
                    pts_match = re.search(r'pts_time:(\d+\.?\d*)', line)
                    if pts_match:
                        scene_timestamps.append(float(pts_match.group(1)))
                except ValueError:
                    pass
        
        print(f"Detected {len(scene_timestamps)} scene changes")
        return scene_timestamps
        
    except subprocess.TimeoutExpired:
        print("Scene detection timeout")
        return []


def detect_flash_frames(video_path: str) -> list[dict]:
    """Detect flash frames (sudden brightness spikes) using FFmpeg."""
    issues = []
    
    # Use the showinfo filter to detect sudden luminance changes
    cmd = [
        'ffmpeg', '-i', video_path,
        '-vf', 'select=\'gt(scene,0.8)\',showinfo',
        '-f', 'null', '-'
    ]
    
    flash_timestamps = []
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        stderr = result.stderr
        
        for line in stderr.split('\n'):
            if 'pts_time:' in line:
                try:
                    pts_match = re.search(r'pts_time:(\d+\.?\d*)', line)
                    if pts_match:
                        flash_timestamps.append(float(pts_match.group(1)))
                except ValueError:
                    pass
        
        if flash_timestamps:
            issues.append({
                'type': 'warning',
                'category': 'Flash Frames',
                'title': f'{len(flash_timestamps)} potential flash frames detected',
                'description': f'Found sudden brightness changes at: {", ".join([f"{t:.1f}s" for t in flash_timestamps[:10]])}{"..." if len(flash_timestamps) > 10 else ""}. Review for unintended flashes.',
                'timestamp': flash_timestamps[0] if flash_timestamps else None
            })
        
        print(f"Detected {len(flash_timestamps)} potential flash frames")
        
    except subprocess.TimeoutExpired:
        issues.append({
            'type': 'warning',
            'category': 'Analysis',
            'title': 'Flash frame detection timeout',
            'description': 'Flash frame analysis took too long.',
            'timestamp': None
        })
    
    return issues


def detect_freeze_frames(video_path: str) -> list[dict]:
    """Detect freeze frames (duplicate frames) using FFmpeg."""
    issues = []
    
    cmd = [
        'ffmpeg', '-i', video_path,
        '-vf', 'freezedetect=n=0.003:d=0.5',
        '-f', 'null', '-'
    ]
    
    freeze_segments = []
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        stderr = result.stderr
        
        for line in stderr.split('\n'):
            if 'freeze_start' in line:
                try:
                    start_match = re.search(r'freeze_start:\s*(\d+\.?\d*)', line)
                    if start_match:
                        freeze_segments.append(float(start_match.group(1)))
                except ValueError:
                    pass
        
        if len(freeze_segments) > 2:
            issues.append({
                'type': 'warning',
                'category': 'Freeze Frames',
                'title': f'{len(freeze_segments)} freeze frame sequences detected',
                'description': f'Found frozen video at: {", ".join([f"{t:.1f}s" for t in freeze_segments[:5]])}{"..." if len(freeze_segments) > 5 else ""}. Verify these are intentional.',
                'timestamp': freeze_segments[0] if freeze_segments else None
            })
        
        print(f"Detected {len(freeze_segments)} freeze frame segments")
        
    except subprocess.TimeoutExpired:
        issues.append({
            'type': 'warning',
            'category': 'Analysis',
            'title': 'Freeze frame detection timeout',
            'description': 'Freeze frame analysis took too long.',
            'timestamp': None
        })
    
    return issues


def extract_frames_smart(video_path: str, temp_dir: str, mode: str = 'thorough') -> list[str]:
    """Extract frames distributed across the ENTIRE video duration."""
    frame_paths = []
    duration = get_video_duration(video_path)
    
    print(f"Video duration: {duration:.1f}s, mode: {mode}")
    
    if mode == 'quick':
        # Quick mode: uniform sampling across entire video
        num_frames = QUICK_MODE_FRAMES
        # Distribute evenly from 5% to 95% of video to ensure full coverage
        timestamps = []
        for i in range(num_frames):
            # Map i to range [0.05, 0.95] of duration
            position = 0.05 + (0.90 * i / (num_frames - 1)) if num_frames > 1 else 0.5
            timestamps.append(duration * position)
        print(f"Quick mode: sampling at {[f'{t:.1f}s' for t in timestamps]}")
    else:
        # Thorough mode: combine uniform sampling with scene-change sampling
        scene_changes = detect_scene_changes(video_path, SCENE_CHANGE_THRESHOLD)
        
        # Distribute uniform samples across ENTIRE video (beginning, middle, end)
        num_uniform = THOROUGH_MODE_FRAMES // 2
        uniform_timestamps = []
        for i in range(num_uniform):
            # Map to range [0.03, 0.97] of duration for full coverage
            position = 0.03 + (0.94 * i / (num_uniform - 1)) if num_uniform > 1 else 0.5
            uniform_timestamps.append(duration * position)
        
        # Sample scene changes from across entire video, not just first 10
        # Divide video into segments and pick scene changes from each segment
        scene_timestamps = []
        if scene_changes:
            num_segments = 5
            segment_duration = duration / num_segments
            for seg in range(num_segments):
                seg_start = seg * segment_duration
                seg_end = (seg + 1) * segment_duration
                # Find scene changes in this segment
                seg_scenes = [sc for sc in scene_changes if seg_start <= sc < seg_end]
                # Take up to 2 scene changes per segment
                for sc in seg_scenes[:2]:
                    if sc + 0.1 < duration:
                        scene_timestamps.append(sc + 0.1)
        
        # Merge and deduplicate (keep unique timestamps at least 0.5s apart)
        all_timestamps = sorted(set(uniform_timestamps + scene_timestamps))
        timestamps = []
        last_ts = -1
        for ts in all_timestamps:
            if ts - last_ts >= 0.5:
                timestamps.append(ts)
                last_ts = ts
        
        timestamps = timestamps[:THOROUGH_MODE_FRAMES]  # Cap at max frames
        print(f"Thorough mode: {len(uniform_timestamps)} uniform + {len(scene_timestamps)} scene-based samples")
        print(f"Final timestamps: {[f'{t:.1f}s' for t in timestamps]}")
    
    print(f"Extracting {len(timestamps)} frames across {duration:.1f}s video")
    
    for i, timestamp in enumerate(timestamps):
        frame_path = os.path.join(temp_dir, f"frame_{i:03d}.jpg")
        
        extract_cmd = [
            'ffmpeg', '-y', '-ss', str(timestamp),
            '-i', video_path,
            '-vframes', '1',
            '-q:v', '2',
            frame_path
        ]
        
        try:
            subprocess.run(extract_cmd, capture_output=True, timeout=30)
            if os.path.exists(frame_path):
                frame_paths.append(frame_path)
        except subprocess.TimeoutExpired:
            print(f"Frame extraction timeout at {timestamp}s")
            continue
    
    print(f"Extracted {len(frame_paths)} frames")
    return frame_paths


def analyze_audio(video_path: str) -> dict:
    """Analyze audio levels using FFmpeg."""
    issues = []
    
    # Run volumedetect filter
    cmd = [
        'ffmpeg', '-i', video_path,
        '-af', 'volumedetect',
        '-f', 'null', '-'
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        stderr = result.stderr
        
        # Parse volume statistics
        mean_volume = None
        max_volume = None
        
        for line in stderr.split('\n'):
            if 'mean_volume' in line:
                try:
                    mean_volume = float(line.split('mean_volume:')[1].split('dB')[0].strip())
                except (IndexError, ValueError):
                    pass
            if 'max_volume' in line:
                try:
                    max_volume = float(line.split('max_volume:')[1].split('dB')[0].strip())
                except (IndexError, ValueError):
                    pass
        
        # Check dialogue levels
        if mean_volume is not None:
            deviation = abs(mean_volume - DIALOGUE_TARGET_DB)
            if deviation > DIALOGUE_TOLERANCE_DB:
                issues.append({
                    'type': 'error' if deviation > DIALOGUE_TOLERANCE_DB * 1.5 else 'warning',
                    'category': 'Audio Levels',
                    'title': 'Dialogue levels outside target range',
                    'description': f'Average dialogue at {mean_volume:.1f}dB (target: {DIALOGUE_TARGET_DB}dB ±{DIALOGUE_TOLERANCE_DB}dB). Consider normalizing audio.',
                    'timestamp': None
                })
        
        # Check peak levels
        if max_volume is not None:
            if max_volume > PEAK_ERROR_THRESHOLD_DB:
                issues.append({
                    'type': 'error',
                    'category': 'Audio Peaks',
                    'title': 'Audio peaks may cause clipping',
                    'description': f'Peak level at {max_volume:.1f}dB exceeds {PEAK_ERROR_THRESHOLD_DB}dB threshold. Risk of distortion on playback.',
                    'timestamp': None
                })
            elif max_volume > PEAK_WARNING_THRESHOLD_DB:
                issues.append({
                    'type': 'warning',
                    'category': 'Audio Peaks',
                    'title': 'Audio peaks near clipping threshold',
                    'description': f'Peak level at {max_volume:.1f}dB is close to {PEAK_ERROR_THRESHOLD_DB}dB limit.',
                    'timestamp': None
                })
        
        # Check for audio dropouts (silence detection)
        silence_cmd = [
            'ffmpeg', '-i', video_path,
            '-af', 'silencedetect=noise=-50dB:d=0.5',
            '-f', 'null', '-'
        ]
        
        silence_result = subprocess.run(silence_cmd, capture_output=True, text=True, timeout=300)
        silence_count = silence_result.stderr.count('silence_start')
        
        if silence_count > 5:
            issues.append({
                'type': 'warning',
                'category': 'Audio Continuity',
                'title': 'Multiple audio dropouts detected',
                'description': f'Found {silence_count} silence gaps longer than 0.5s. Verify these are intentional.',
                'timestamp': None
            })
        
        return {
            'averageDialogueDb': mean_volume,
            'peakDb': max_volume,
            'silenceGaps': silence_count,
            'issues': issues,
            'summary': f'Audio analysis complete. Mean: {mean_volume or "N/A"}dB, Peak: {max_volume or "N/A"}dB'
        }
        
    except subprocess.TimeoutExpired:
        return {
            'averageDialogueDb': None,
            'peakDb': None,
            'silenceGaps': 0,
            'issues': [{
                'type': 'warning',
                'category': 'Analysis',
                'title': 'Audio analysis timeout',
                'description': 'Audio analysis took too long. Video may be very long or corrupted.',
                'timestamp': None
            }],
            'summary': 'Audio analysis timed out'
        }


def detect_black_frames(video_path: str) -> list[dict]:
    """Detect black frames using FFmpeg."""
    issues = []
    
    cmd = [
        'ffmpeg', '-i', video_path,
        '-vf', 'blackdetect=d=0.1:pix_th=0.10',  # Reduced duration to catch brief black frames
        '-an', '-f', 'null', '-'
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        stderr = result.stderr
        
        black_segments = []
        for line in stderr.split('\n'):
            if 'black_start' in line:
                try:
                    start = float(line.split('black_start:')[1].split()[0])
                    black_segments.append(start)
                except (IndexError, ValueError):
                    pass
        
        if len(black_segments) > 3:
            issues.append({
                'type': 'warning',
                'category': 'Black Frames',
                'title': f'{len(black_segments)} black frame sequences detected',
                'description': f'Found black segments at: {", ".join([f"{t:.1f}s" for t in black_segments[:5]])}{"..." if len(black_segments) > 5 else ""}',
                'timestamp': black_segments[0] if black_segments else None
            })
        
    except subprocess.TimeoutExpired:
        issues.append({
            'type': 'warning',
            'category': 'Analysis',
            'title': 'Black frame detection timeout',
            'description': 'Black frame analysis took too long.',
            'timestamp': None
        })
    
    return issues


def load_known_exceptions() -> list[dict]:
    """Load known exceptions from GCS feedback.json (the Memory Layer)."""
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(GCS_BUCKET)
        blob = bucket.blob('config/feedback.json')
        
        if not blob.exists():
            print("No feedback.json found, no known exceptions to load")
            return []
        
        content = blob.download_as_text()
        feedback = json.loads(content)
        
        exceptions = feedback.get('known_exceptions', [])
        print(f"Loaded {len(exceptions)} known exception patterns from Memory Layer")
        return exceptions
        
    except Exception as e:
        print(f"Could not load known exceptions: {e}")
        return []


def build_prompt_for_mode(mode: str, known_exceptions: list[dict]) -> str:
    """Build role-based prompt based on analysis mode."""
    
    # Build known exceptions context if any
    exceptions_context = ""
    if known_exceptions:
        exception_lines = []
        for exc in known_exceptions[:20]:  # Limit to top 20
            exception_lines.append(f"- {exc.get('category', 'Unknown')}: {exc.get('pattern', '')} (dismissed {exc.get('count', 0)} times)")
        exceptions_context = f"""

KNOWN EXCEPTIONS (issues previously dismissed by editors as acceptable):
{chr(10).join(exception_lines)}

Do NOT flag issues that match these known exceptions unless they are severe errors."""

    if mode == 'quick':
        # Quick mode: QC Editor persona - fast pass/fail
        return f"""You are a QC Editor performing a quick technical review. Your job is to catch obvious errors quickly, not to nitpick.

Scan these video frames for:
1. **Obvious visual errors**: glaring artifacts, black frames, severe color issues
2. **Brand logo accuracy**: if logos are visible, are they correct?
3. **Major technical problems**: severe compression, visible interlacing

Be efficient. Only flag issues that would definitely require a revision.
Ignore minor imperfections that are acceptable in professional video.
{exceptions_context}

Respond in JSON format:
{{
  "issues": [
    {{
      "category": "string",
      "type": "error|warning|info",
      "title": "string",
      "description": "string"
    }}
  ],
  "summary": "PASS/FAIL with brief reason",
  "qualityScore": 1-10
}}

If the video passes basic QC, return empty issues array with "PASS: [reason]" summary."""
    
    else:
        # Thorough mode: Senior Creative Director persona - detailed analysis
        return f"""You are a Senior Creative Director reviewing this video with a critical eye for both technical quality and creative execution.

Analyze these frames in detail for:

**Technical Quality:**
1. Visual artifacts, compression issues, banding, blocking, interlacing
2. Color consistency: white balance, grading continuity between shots, color banding
3. Exposure: blown highlights, crushed blacks, underexposure
4. Frame integrity: aspect ratio issues, unintended letterboxing

**Creative Execution:**
5. Pacing: any visible jump cuts or jarring transitions
6. Brand consistency: logo placement, color accuracy (check against brand HEX if visible)
7. Lower-third typography: font consistency, safe area compliance
8. Continuity: any visible mismatches between shots
{exceptions_context}

For each issue found, provide timestamped feedback when possible.
Be thorough but fair - distinguish between must-fix errors and should-review suggestions.

Respond in JSON format:
{{
  "issues": [
    {{
      "category": "string",
      "type": "error|warning|info",
      "title": "string",
      "description": "detailed explanation with fix suggestion"
    }}
  ],
  "summary": "Detailed quality assessment (2-3 sentences)",
  "qualityScore": 1-10
}}

If the video meets professional standards, return empty issues array with positive summary."""


def analyze_with_gemini(frame_paths: list[str], file_name: str, mode: str = 'thorough', known_exceptions: list[dict] = None) -> dict:
    """Analyze frames using Vertex AI Gemini for creative/quality issues."""
    if not frame_paths:
        return {
            'issues': [],
            'summary': 'No frames available for visual analysis'
        }
    
    issues = []
    
    try:
        model = GenerativeModel("gemini-2.0-flash")
        
        # Limit frames based on mode
        max_frames = 5 if mode == 'quick' else 8
        frames_to_analyze = frame_paths[:max_frames]
        
        # Load frames as base64
        frame_parts = []
        for path in frames_to_analyze:
            with open(path, 'rb') as f:
                frame_data = f.read()
                frame_parts.append(Part.from_data(frame_data, mime_type="image/jpeg"))
        
        # Build role-based prompt with known exceptions
        prompt = build_prompt_for_mode(mode, known_exceptions or [])

        response = model.generate_content([prompt] + frame_parts)
        response_text = response.text
        
        # Parse JSON from response
        try:
            json_match = response_text
            if '```json' in response_text:
                json_match = response_text.split('```json')[1].split('```')[0]
            elif '```' in response_text:
                json_match = response_text.split('```')[1].split('```')[0]
            
            parsed = json.loads(json_match.strip())
            
            for issue in parsed.get('issues', []):
                issues.append({
                    'type': issue.get('type', 'warning'),
                    'category': issue.get('category', 'Visual'),
                    'title': issue.get('title', 'Visual issue detected'),
                    'description': issue.get('description', ''),
                    'timestamp': None
                })
            
            return {
                'framesAnalyzed': len(frame_paths),
                'issues': issues,
                'summary': parsed.get('summary', 'Visual analysis complete'),
                'qualityScore': parsed.get('qualityScore', 7)
            }
            
        except json.JSONDecodeError:
            return {
                'framesAnalyzed': len(frame_paths),
                'issues': [],
                'summary': response_text[:200] if response_text else 'Visual analysis complete',
                'qualityScore': 7
            }
            
    except Exception as e:
        print(f"Gemini analysis error: {e}")
        return {
            'framesAnalyzed': len(frame_paths),
            'issues': [{
                'type': 'warning',
                'category': 'Analysis',
                'title': 'AI visual analysis unavailable',
                'description': f'Could not complete AI analysis: {str(e)[:100]}',
                'timestamp': None
            }],
            'summary': 'AI visual analysis failed'
        }


def submit_results(upload_id: str, visual_analysis: dict, audio_analysis: dict, success: bool = True):
    """Submit analysis results to Supabase edge function."""
    if not SUPABASE_URL or not GCP_CALLBACK_SECRET:
        print("Missing SUPABASE_URL or GCP_CALLBACK_SECRET")
        return False
    
    callback_url = f"{SUPABASE_URL}/functions/v1/gcp-analysis-callback"
    
    payload = {
        'uploadId': upload_id,
        'success': success,
        'visualAnalysis': visual_analysis,
        'audioAnalysis': audio_analysis
    }
    
    headers = {
        'Content-Type': 'application/json',
        'x-gcp-secret': GCP_CALLBACK_SECRET
    }
    
    try:
        response = requests.post(callback_url, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        print(f"Results submitted for upload {upload_id}")
        return True
    except requests.RequestException as e:
        print(f"Failed to submit results: {e}")
        return False


def get_analysis_mode_from_metadata(bucket_name: str, blob_name: str) -> str:
    """Check for analysis mode in object metadata."""
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        blob.reload()  # Fetch metadata
        
        metadata = blob.metadata or {}
        mode = metadata.get('analysis_mode', 'thorough')
        print(f"Analysis mode from metadata: {mode}")
        return mode
    except Exception as e:
        print(f"Could not read metadata: {e}")
        return 'thorough'  # Default to thorough


def process_video_async(bucket_name: str, blob_name: str, upload_id: str, mode: str, job_id: str):
    """
    Background video processing - runs in separate thread.
    This function handles the heavy lifting: download, FFmpeg analysis, Gemini AI, and callback.
    """
    print(f"[Job {job_id}] Starting async processing for upload {upload_id}")
    
    # Update job status
    with jobs_lock:
        processing_jobs[job_id] = {'status': 'processing', 'upload_id': upload_id}
    
    try:
        # Create temp directory for processing
        with tempfile.TemporaryDirectory() as temp_dir:
            # Download video
            print(f"[Job {job_id}] Downloading video...")
            video_path = download_video(bucket_name, blob_name, temp_dir)
            
            # Load known exceptions from Memory Layer
            known_exceptions = load_known_exceptions()
            
            # Run analyses based on mode
            if mode == 'quick':
                # Quick mode: minimal analysis with QC Editor persona
                print(f"[Job {job_id}] Running quick analysis...")
                frames = extract_frames_smart(video_path, temp_dir, mode='quick')
                audio_analysis = analyze_audio(video_path)
                visual_analysis = analyze_with_gemini(frames, os.path.basename(blob_name), mode='quick', known_exceptions=known_exceptions)
                
            else:
                # Thorough mode: comprehensive analysis with Creative Director persona
                print(f"[Job {job_id}] Running thorough analysis...")
                frames = extract_frames_smart(video_path, temp_dir, mode='thorough')
                
                # Run all detection
                audio_analysis = analyze_audio(video_path)
                black_frame_issues = detect_black_frames(video_path)
                flash_frame_issues = detect_flash_frames(video_path)
                freeze_frame_issues = detect_freeze_frames(video_path)
                visual_analysis = analyze_with_gemini(frames, os.path.basename(blob_name), mode='thorough', known_exceptions=known_exceptions)
                
                # Merge all FFmpeg-detected issues into visual analysis
                all_ffmpeg_issues = black_frame_issues + flash_frame_issues + freeze_frame_issues
                visual_analysis['issues'] = visual_analysis.get('issues', []) + all_ffmpeg_issues
            
            # Submit results
            print(f"[Job {job_id}] Submitting results...")
            submit_results(upload_id, visual_analysis, audio_analysis, success=True)
            
            # Update job status
            with jobs_lock:
                processing_jobs[job_id] = {
                    'status': 'completed',
                    'upload_id': upload_id,
                    'frames_analyzed': len(frames),
                    'visual_issues': len(visual_analysis.get('issues', [])),
                    'audio_issues': len(audio_analysis.get('issues', []))
                }
            
            print(f"[Job {job_id}] Processing complete for upload {upload_id}")
            
    except Exception as e:
        print(f"[Job {job_id}] Analysis error: {e}")
        
        # Submit failure result
        submit_results(
            upload_id,
            {'issues': [], 'summary': f'Analysis failed: {str(e)[:100]}'},
            {'issues': [], 'summary': 'Analysis failed'},
            success=False
        )
        
        # Update job status
        with jobs_lock:
            processing_jobs[job_id] = {
                'status': 'failed',
                'upload_id': upload_id,
                'error': str(e)[:200]
            }


@app.route('/', methods=['POST'])
def handle_gcs_event():
    """
    Handle GCS Eventarc trigger for new video uploads.
    
    Returns 202 Accepted immediately and processes video in background thread.
    This prevents Cloud Run health check timeouts for large video files.
    """
    
    # Parse Cloud Event
    envelope = request.get_json()
    
    if not envelope:
        return jsonify({'error': 'No event data received'}), 400
    
    # Handle Pub/Sub wrapped event
    if 'message' in envelope:
        message = envelope['message']
        if 'data' in message:
            event_data = json.loads(base64.b64decode(message['data']).decode('utf-8'))
        else:
            event_data = message
    else:
        event_data = envelope
    
    bucket_name = event_data.get('bucket', GCS_BUCKET)
    blob_name = event_data.get('name')
    
    if not blob_name:
        return jsonify({'error': 'No file name in event'}), 400
    
    # Skip folder objects
    if blob_name.endswith('/'):
        print(f"Skipping folder object: {blob_name}")
        return jsonify({'skipped': True, 'reason': 'folder object'}), 200
    
    # Only process video files
    video_extensions = ('.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mxf', '.prores')
    if not blob_name.lower().endswith(video_extensions):
        print(f"Skipping non-video file: {blob_name}")
        return jsonify({'skipped': True, 'reason': 'not a video file'}), 200
    
    # Extract upload ID from path
    path_parts = blob_name.split('/')
    upload_id = None
    
    uuid_pattern = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$', re.IGNORECASE)
    
    for part in path_parts:
        if uuid_pattern.match(part):
            upload_id = part
            break
    
    if not upload_id:
        print(f"Skipping file without valid UUID in path: {blob_name}")
        return jsonify({'skipped': True, 'reason': 'no valid UUID in path'}), 200
    
    # Get analysis mode from object metadata
    mode = get_analysis_mode_from_metadata(bucket_name, blob_name)
    
    print(f"Queuing video for processing: {blob_name} (upload_id: {upload_id}, mode: {mode})")
    
    # Generate job ID and start background processing
    job_id = str(uuid.uuid4())
    
    thread = threading.Thread(
        target=process_video_async,
        args=(bucket_name, blob_name, upload_id, mode, job_id),
        daemon=True  # Daemon thread so it doesn't block container shutdown
    )
    thread.start()
    
    # Track job
    with jobs_lock:
        processing_jobs[job_id] = {'status': 'queued', 'upload_id': upload_id}
    
    # Return immediately - don't wait for processing
    return jsonify({
        'accepted': True,
        'jobId': job_id,
        'uploadId': upload_id,
        'mode': mode,
        'message': 'Video queued for analysis'
    }), 202  # HTTP 202 Accepted


@app.route('/job/<job_id>', methods=['GET'])
def get_job_status(job_id: str):
    """Get the status of a processing job."""
    with jobs_lock:
        job = processing_jobs.get(job_id)
    
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    
    return jsonify(job)


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for Cloud Run."""
    return jsonify({'status': 'healthy', 'service': 'tcv-video-analyzer'})


@app.route('/startup', methods=['GET'])
def startup_check():
    """Startup probe endpoint for Cloud Run."""
    return jsonify({'status': 'ready', 'service': 'tcv-video-analyzer'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
