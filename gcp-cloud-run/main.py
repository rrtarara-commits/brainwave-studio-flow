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
import time
import concurrent.futures
import requests
from flask import Flask, request, jsonify
from google.cloud import storage
import vertexai
from vertexai.generative_models import GenerativeModel, Part, GenerationConfig

app = Flask(__name__)

# Configuration helpers
def _env_trim(name: str, default: str = '') -> str:
    return (os.environ.get(name, default) or '').strip()


def _sanitize_header_secret(raw: str) -> str:
    # Remove any whitespace/newlines that can invalidate HTTP header values.
    # JWTs and callback secrets should not contain spaces.
    return ''.join((raw or '').split())


# Configuration
GCS_BUCKET = _env_trim('GCS_BUCKET', 'tcv-video-uploads')
SUPABASE_URL = _env_trim('SUPABASE_URL').rstrip('/')
SUPABASE_SERVICE_ROLE_KEY = _sanitize_header_secret(_env_trim('SUPABASE_SERVICE_ROLE_KEY'))
GCP_CALLBACK_SECRET = _sanitize_header_secret(_env_trim('GCP_CALLBACK_SECRET'))
PROJECT_ID = _env_trim('GOOGLE_CLOUD_PROJECT')

print(
    "[Config] "
    f"bucket={GCS_BUCKET or '<missing>'}, "
    f"supabase_url={'set' if SUPABASE_URL else 'missing'}, "
    f"service_key_len={len(SUPABASE_SERVICE_ROLE_KEY)}, "
    f"callback_secret_len={len(GCP_CALLBACK_SECRET)}"
)

# FFmpeg tuning. This service commonly runs multiple FFmpeg processes in parallel,
# so we want to avoid oversubscribing CPU threads.
def _env_int(name: str, default: int, minimum: int = 1, maximum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == '':
        val = default
    else:
        try:
            val = int(str(raw).strip())
        except ValueError:
            val = default
    if val < minimum:
        val = minimum
    if maximum is not None and val > maximum:
        val = maximum
    return val


FFMPEG_THREADS = _env_int("FFMPEG_THREADS", 2, minimum=1, maximum=8)
MAX_CONCURRENT_JOBS = _env_int("MAX_CONCURRENT_JOBS", 1, minimum=1, maximum=8)
job_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_JOBS)

# Audio analysis thresholds
DIALOGUE_TARGET_DB = -3.0
DIALOGUE_TOLERANCE_DB = 3.0
PEAK_ERROR_THRESHOLD_DB = -0.5
PEAK_WARNING_THRESHOLD_DB = -1.0

# Analysis mode settings - frames distributed across ENTIRE video
QUICK_MODE_FRAMES = 8  # More frames for better coverage
THOROUGH_MODE_FRAMES = 20  # Increased for full video analysis
QUICK_MODE_MODEL_FRAMES = 5
THOROUGH_MODE_MODEL_FRAMES = 8
SCENE_CHANGE_THRESHOLD = 0.3  # Lower = more sensitive

# Job tracking for background processing
processing_jobs = {}
jobs_lock = threading.Lock()

# Cache known exceptions for a short TTL to avoid repeated GCS reads per job.
known_exceptions_cache: list[dict] = []
known_exceptions_cache_ts = 0.0
KNOWN_EXCEPTIONS_TTL_SECONDS = 300
known_exceptions_lock = threading.Lock()

# Initialize Vertex AI
vertexai.init(project=PROJECT_ID, location="us-central1")


def acquire_deep_analysis_lock(
    upload_id: str,
    bucket_name: str,
    blob_name: str,
    job_id: str,
    generation: str | None,
) -> bool:
    """
    Best-effort distributed idempotency guard.

    GCS/Eventarc delivery is at-least-once; the same object can trigger multiple
    events. We try to insert a single-row lock keyed by upload_id. If it already
    exists, we skip to avoid duplicate processing and wasted compute.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        # Can't lock without Supabase config; proceed.
        return True

    url = f"{SUPABASE_URL}/rest/v1/deep_analysis_locks"
    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }
    payload = {
        'upload_id': upload_id,
        'gcs_bucket': bucket_name,
        'gcs_object': blob_name,
        'gcs_generation': str(generation) if generation is not None else None,
        'job_id': job_id,
    }

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
        if resp.status_code in {200, 201, 204}:
            print(f"[Lock] Acquired: upload_id={upload_id}")
            return True
        if resp.status_code == 409:
            print(f"[Lock] Duplicate event detected; skipping: upload_id={upload_id}")
            return False
        if resp.status_code == 400 and 'duplicate' in (resp.text or '').lower():
            print(f"[Lock] Duplicate event detected; skipping: upload_id={upload_id}")
            return False
        # If table doesn't exist yet or another error happens, don't block processing.
        print(f"[Lock] Unexpected response ({resp.status_code}): {resp.text[:200]}")
        return True
    except Exception as e:
        print(f"[Lock] Error acquiring lock (proceeding anyway): {e}")
        return True


def _is_permanent_gcs_download_error(err: Exception) -> bool:
    msg = str(err).lower()
    # Retrying these generally won't help.
    permanent_markers = (
        '403',
        'forbidden',
        'permission',
        '401',
        'unauthorized',
        '404',
        'not found',
    )
    return any(marker in msg for marker in permanent_markers)


def download_video(bucket_name: str, blob_name: str, temp_dir: str) -> str:
    """Download video from GCS to local temp storage with retries."""
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)

    local_path = os.path.join(temp_dir, os.path.basename(blob_name))
    max_attempts = 5
    base_backoff_seconds = 2.0

    for attempt in range(1, max_attempts + 1):
        try:
            # Ensure object metadata is resolvable before download.
            blob.reload(timeout=60)
            blob.download_to_filename(local_path, timeout=300)
            print(f"Downloaded {blob_name} to {local_path} on attempt {attempt}")
            return local_path
        except Exception as e:
            if os.path.exists(local_path):
                try:
                    os.remove(local_path)
                except OSError:
                    pass

            permanent = _is_permanent_gcs_download_error(e)
            print(
                f"GCS download attempt {attempt}/{max_attempts} failed "
                f"(permanent={permanent}): {e}"
            )
            if permanent or attempt == max_attempts:
                raise

            backoff_seconds = min(20.0, base_backoff_seconds * (2 ** (attempt - 1)))
            time.sleep(backoff_seconds)

    raise RuntimeError(f"Failed to download {blob_name} after {max_attempts} attempts")


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
        'ffmpeg',
        '-hide_banner',
        '-nostats',
        '-threads', str(FFMPEG_THREADS),
        '-i', video_path,
        '-vf', f'select=\'gt(scene,{threshold})\',showinfo',
        '-f', 'null', '-'
    ]
    
    scene_timestamps = []
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
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
        'ffmpeg',
        '-hide_banner',
        '-nostats',
        '-threads', str(FFMPEG_THREADS),
        '-i', video_path,
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
        'ffmpeg',
        '-hide_banner',
        '-nostats',
        '-threads', str(FFMPEG_THREADS),
        '-i', video_path,
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


def select_evenly_distributed_timestamps(timestamps: list[float], target_count: int) -> list[float]:
    """Select evenly distributed timestamps from a sorted list."""
    if target_count <= 0:
        return []
    if len(timestamps) <= target_count:
        return timestamps
    if target_count == 1:
        return [timestamps[len(timestamps) // 2]]

    selected: list[float] = []
    for i in range(target_count):
        idx = round(i * (len(timestamps) - 1) / (target_count - 1))
        selected.append(timestamps[idx])

    # Remove accidental duplicates caused by rounding and backfill from source list.
    deduped: list[float] = []
    seen: set[float] = set()
    for ts in selected:
        key = round(ts, 3)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ts)

    if len(deduped) < target_count:
        for ts in timestamps:
            key = round(ts, 3)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(ts)
            if len(deduped) >= target_count:
                break

    return sorted(deduped)


def extract_frames_smart(
    video_path: str,
    temp_dir: str,
    mode: str = 'thorough',
    target_frames: int | None = None
) -> list[dict]:
    """Extract frames distributed across the ENTIRE video duration."""
    frame_samples = []
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
        scene_changes: list[float] = []
        # Scene-change detection can be expensive on long videos and isn't needed
        # to extract only a handful of representative frames.
        if duration <= 600:
            scene_changes = detect_scene_changes(video_path, SCENE_CHANGE_THRESHOLD)
        else:
            print("Skipping scene detection (video too long)")
        
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

    # Downsample candidates to the exact number we intend to analyze.
    if target_frames is not None and target_frames > 0:
        timestamps = select_evenly_distributed_timestamps(timestamps, target_frames)

    print(f"Final timestamps: {[f'{t:.1f}s' for t in timestamps]}")
    
    print(f"Extracting {len(timestamps)} frames across {duration:.1f}s video")
    
    for i, timestamp in enumerate(timestamps):
        frame_path = os.path.join(temp_dir, f"frame_{i:03d}.jpg")
        
        extract_cmd = [
            'ffmpeg',
            '-hide_banner',
            '-nostats',
            '-threads', '1',
            '-y', '-ss', str(timestamp),
            '-i', video_path,
            '-vframes', '1',
            '-q:v', '2',
            frame_path
        ]
        
        try:
            subprocess.run(extract_cmd, capture_output=True, timeout=30)
            if os.path.exists(frame_path):
                frame_samples.append({
                    'path': frame_path,
                    'timestamp': float(timestamp),
                })
        except subprocess.TimeoutExpired:
            print(f"Frame extraction timeout at {timestamp}s")
            continue
    
    print(f"Extracted {len(frame_samples)} frames")
    return frame_samples


def analyze_audio(video_path: str) -> dict:
    """Analyze audio levels using FFmpeg."""
    issues = []
    
    # Run a single pass with both volumedetect and silencedetect.
    cmd = [
        'ffmpeg',
        '-hide_banner',
        '-nostats',
        '-threads', str(FFMPEG_THREADS),
        '-i', video_path,
        '-vn',
        '-af', 'volumedetect,silencedetect=noise=-50dB:d=0.5',
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
        silence_count = stderr.count('silence_start')
        
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
        'ffmpeg',
        '-hide_banner',
        '-nostats',
        '-threads', str(FFMPEG_THREADS),
        '-i', video_path,
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


def detect_video_issues(video_path: str) -> list[dict]:
    """
    Single-pass video-only FFmpeg scan that combines:
    - blackdetect
    - freezedetect
    - flash-like abrupt-change detection via scene threshold

    This replaces multiple full-video FFmpeg passes, which can be very slow.
    """
    issues: list[dict] = []

    # Filter graph:
    # - Branch 1: blackdetect + freezedetect over full video
    # - Branch 2: scene-based frame selection (historically used as "flash" heuristic)
    filter_complex = (
        "[0:v]split=2[vmain][vflash];"
        "[vmain]blackdetect=d=0.1:pix_th=0.10,freezedetect=n=0.003:d=0.5[vmainout];"
        "[vflash]select='gt(scene,0.8)',showinfo[vflashout]"
    )

    cmd = [
        'ffmpeg',
        '-hide_banner',
        '-nostats',
        '-threads', str(FFMPEG_THREADS),
        '-i', video_path,
        '-filter_complex', filter_complex,
        '-map', '[vmainout]', '-f', 'null', '/dev/null',
        '-map', '[vflashout]', '-f', 'null', '/dev/null',
    ]

    black_segments: list[float] = []
    freeze_segments: list[float] = []
    flash_timestamps: list[float] = []

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        stderr = result.stderr or ""

        for line in stderr.split('\n'):
            if 'black_start' in line:
                try:
                    start = float(line.split('black_start:')[1].split()[0])
                    black_segments.append(start)
                except (IndexError, ValueError):
                    pass
                continue

            if 'freeze_start' in line:
                try:
                    start_match = re.search(r'freeze_start:\s*(\d+\.?\d*)', line)
                    if start_match:
                        freeze_segments.append(float(start_match.group(1)))
                except ValueError:
                    pass
                continue

            if 'pts_time:' in line:
                # showinfo output from the flash branch
                try:
                    pts_match = re.search(r'pts_time:(\d+\.?\d*)', line)
                    if pts_match:
                        flash_timestamps.append(float(pts_match.group(1)))
                except ValueError:
                    pass

        if len(black_segments) > 3:
            issues.append({
                'type': 'warning',
                'category': 'Black Frames',
                'title': f'{len(black_segments)} black frame sequences detected',
                'description': f'Found black segments at: {", ".join([f"{t:.1f}s" for t in black_segments[:5]])}{"..." if len(black_segments) > 5 else ""}',
                'timestamp': black_segments[0] if black_segments else None
            })

        if len(freeze_segments) > 2:
            issues.append({
                'type': 'warning',
                'category': 'Freeze Frames',
                'title': f'{len(freeze_segments)} freeze frame sequences detected',
                'description': f'Found frozen video at: {", ".join([f"{t:.1f}s" for t in freeze_segments[:5]])}{"..." if len(freeze_segments) > 5 else ""}. Verify these are intentional.',
                'timestamp': freeze_segments[0] if freeze_segments else None
            })

        if flash_timestamps:
            issues.append({
                'type': 'warning',
                'category': 'Flash Frames',
                'title': f'{len(flash_timestamps)} potential flash frames detected',
                'description': f'Found sudden changes at: {", ".join([f"{t:.1f}s" for t in flash_timestamps[:10]])}{"..." if len(flash_timestamps) > 10 else ""}. Review for unintended flashes.',
                'timestamp': flash_timestamps[0] if flash_timestamps else None
            })

        print(f"Video scan results: black={len(black_segments)}, freeze={len(freeze_segments)}, flash={len(flash_timestamps)}")
        return issues

    except subprocess.TimeoutExpired:
        return [{
            'type': 'warning',
            'category': 'Analysis',
            'title': 'Video scan timeout',
            'description': 'Combined video scan took too long.',
            'timestamp': None
        }]


def load_known_exceptions() -> list[dict]:
    """Load known exceptions from GCS feedback.json (the Memory Layer)."""
    global known_exceptions_cache, known_exceptions_cache_ts

    with known_exceptions_lock:
        if known_exceptions_cache and (time.time() - known_exceptions_cache_ts) < KNOWN_EXCEPTIONS_TTL_SECONDS:
            return known_exceptions_cache

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
        if not isinstance(exceptions, list):
            exceptions = []
        with known_exceptions_lock:
            known_exceptions_cache = exceptions
            known_exceptions_cache_ts = time.time()
        print(f"Loaded {len(exceptions)} known exception patterns from Memory Layer")
        return exceptions
        
    except Exception as e:
        print(f"Could not load known exceptions: {e}")
        with known_exceptions_lock:
            # Fallback to cached data if available.
            if known_exceptions_cache:
                return known_exceptions_cache
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
      "description": "string",
      "frameRefs": [0],
      "timestampSec": 12.5
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
      "description": "detailed explanation with fix suggestion",
      "frameRefs": [0],
      "timestampSec": 12.5
    }}
  ],
  "summary": "Detailed quality assessment (2-3 sentences)",
  "qualityScore": 1-10
}}

If the video meets professional standards, return empty issues array with positive summary."""


def parse_json_response_text(response_text: str) -> dict:
    """Parse model JSON response safely with markdown/regex fallbacks."""
    text = (response_text or '').strip()
    if not text:
        return {}

    if text.startswith('```'):
        text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'```$', '', text).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return {}
    return {}


def resolve_issue_timestamp(issue: dict, frame_samples: list[dict]) -> float | None:
    """Resolve issue timestamp from explicit timestamp or frame references."""
    raw_ts = issue.get('timestampSec')
    if isinstance(raw_ts, (int, float)):
        return round(float(raw_ts), 2)

    refs = issue.get('frameRefs', issue.get('frameRef'))
    if refs is None:
        return None

    if not isinstance(refs, list):
        refs = [refs]

    valid_indices: list[int] = []
    for ref in refs:
        try:
            idx = int(ref)
        except (ValueError, TypeError):
            continue
        if 0 <= idx < len(frame_samples):
            valid_indices.append(idx)

    if not valid_indices:
        return None

    # Average referenced frames for a stable anchor timestamp.
    avg_ts = sum(float(frame_samples[idx].get('timestamp', 0.0)) for idx in valid_indices) / len(valid_indices)
    return round(avg_ts, 2)


def analyze_with_gemini(frame_samples: list[dict], file_name: str, mode: str = 'thorough', known_exceptions: list[dict] = None) -> dict:
    """Analyze frames using Vertex AI Gemini for creative/quality issues."""
    if not frame_samples:
        return {
            'issues': [],
            'summary': 'No frames available for visual analysis'
        }

    issues = []

    try:
        model = GenerativeModel("gemini-2.0-flash")

        max_frames = QUICK_MODE_MODEL_FRAMES if mode == 'quick' else THOROUGH_MODE_MODEL_FRAMES
        frames_to_analyze = frame_samples
        if len(frame_samples) > max_frames and max_frames > 0:
            if max_frames == 1:
                frames_to_analyze = [frame_samples[len(frame_samples) // 2]]
            else:
                step = (len(frame_samples) - 1) / (max_frames - 1)
                indices = [round(i * step) for i in range(max_frames)]
                indices = sorted(set(indices))
                while len(indices) < max_frames:
                    for idx in range(len(frame_samples)):
                        if idx not in indices:
                            indices.append(idx)
                        if len(indices) >= max_frames:
                            break
                frames_to_analyze = [frame_samples[idx] for idx in sorted(indices)[:max_frames]]

        frame_parts = []
        for sample in frames_to_analyze:
            with open(sample['path'], 'rb') as f:
                frame_data = f.read()
                frame_parts.append(Part.from_data(frame_data, mime_type="image/jpeg"))

        frame_ref_lines = []
        for idx, sample in enumerate(frames_to_analyze):
            frame_ref_lines.append(f"- {idx}: {float(sample.get('timestamp', 0.0)):.2f}s")

        prompt = (
            build_prompt_for_mode(mode, known_exceptions or [])
            + "\n\nFRAME REFERENCES:\n"
            + "\n".join(frame_ref_lines)
            + "\n\nFor each issue include at least one of: frameRefs (list of frame indices) or timestampSec (seconds)."
        )

        response = model.generate_content(
            [prompt] + frame_parts,
            generation_config=GenerationConfig(
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
        parsed = parse_json_response_text(response.text or '')
        parsed_issues = parsed.get('issues', [])

        if isinstance(parsed_issues, list):
            for issue in parsed_issues:
                if not isinstance(issue, dict):
                    continue
                issues.append({
                    'type': issue.get('type', 'warning'),
                    'category': issue.get('category', 'Visual'),
                    'title': issue.get('title', 'Visual issue detected'),
                    'description': issue.get('description', ''),
                    'timestamp': resolve_issue_timestamp(issue, frames_to_analyze),
                })

        quality_score = parsed.get('qualityScore', 7)
        if not isinstance(quality_score, (int, float)):
            quality_score = 7
        quality_score = max(1, min(10, int(round(float(quality_score)))))

        return {
            'framesAnalyzed': len(frames_to_analyze),
            'issues': issues,
            'summary': parsed.get('summary', 'Visual analysis complete') if isinstance(parsed, dict) else 'Visual analysis complete',
            'qualityScore': quality_score,
        }

    except Exception as e:
        print(f"Gemini analysis error: {e}")
        return {
            'framesAnalyzed': len(frame_samples),
            'issues': [{
                'type': 'warning',
                'category': 'Analysis',
                'title': 'AI visual analysis unavailable',
                'description': f'Could not complete AI analysis: {str(e)[:100]}',
                'timestamp': None
            }],
            'summary': 'AI visual analysis failed'
        }


def report_progress(upload_id: str, percent: int, stage: str):
    """Report processing progress to Supabase via REST API."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print(f"[Progress] Skipping (missing config): {percent}% - {stage}")
        return
    
    url = f"{SUPABASE_URL}/rest/v1/video_uploads?id=eq.{upload_id}"
    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }
    payload = {
        'deep_analysis_progress': {'percent': percent, 'stage': stage}
    }
    
    try:
        resp = requests.patch(url, json=payload, headers=headers, timeout=10)
        if resp.status_code < 300:
            print(f"[Progress] {upload_id}: {percent}% - {stage}")
        else:
            print(f"[Progress] Update failed ({resp.status_code}): {resp.text[:200]}")
    except Exception as e:
        print(f"[Progress] Error: {e}")


def mark_deep_analysis_failed(upload_id: str, stage: str):
    """Mark deep analysis as failed in Supabase when callback/progress flow breaks."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print(f"[Failure] Skipping status update (missing config): {upload_id} - {stage}")
        return

    url = f"{SUPABASE_URL}/rest/v1/video_uploads?id=eq.{upload_id}"
    headers = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }
    payload = {
        'deep_analysis_status': 'failed',
        'deep_analysis_progress': {'percent': 100, 'stage': stage[:120]},
    }

    try:
        resp = requests.patch(url, json=payload, headers=headers, timeout=10)
        if resp.status_code < 300:
            print(f"[Failure] Marked {upload_id} failed: {stage}")
        else:
            print(f"[Failure] Failed to mark {upload_id} failed ({resp.status_code}): {resp.text[:200]}")
    except Exception as e:
        print(f"[Failure] Error marking failed status: {e}")


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

    max_attempts = 4
    base_backoff_seconds = 1.0

    for attempt in range(1, max_attempts + 1):
        try:
            response = requests.post(callback_url, json=payload, headers=headers, timeout=30)
            response.raise_for_status()
            print(f"Results submitted for upload {upload_id} on attempt {attempt}")
            return True
        except requests.RequestException as e:
            status_code = getattr(e.response, 'status_code', None) if hasattr(e, 'response') else None
            response_text = getattr(e.response, 'text', '')[:200] if hasattr(e, 'response') and e.response else ''
            print(f"Submit attempt {attempt}/{max_attempts} failed (status={status_code}): {e} {response_text}")

            # Non-transient failures should fail fast.
            if status_code in {400, 401, 403, 404}:
                return False

            if attempt == max_attempts:
                break

            backoff_seconds = min(8.0, base_backoff_seconds * (2 ** (attempt - 1)))
            time.sleep(backoff_seconds)
        except Exception as e:
            # E.g. malformed header values or non-requests runtime failures.
            print(
                f"Submit attempt {attempt}/{max_attempts} runtime error: {e} "
                f"(callback_url={callback_url}, callback_secret_len={len(GCP_CALLBACK_SECRET)})"
            )
            if attempt == max_attempts:
                break
            backoff_seconds = min(8.0, base_backoff_seconds * (2 ** (attempt - 1)))
            time.sleep(backoff_seconds)

    print(f"Failed to submit results after {max_attempts} attempts for upload {upload_id}")
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
    
    acquired_slot = False
    try:
        report_progress(upload_id, 5, f"Waiting for worker slot (max {MAX_CONCURRENT_JOBS}/instance)...")
        job_semaphore.acquire()
        acquired_slot = True
        report_progress(upload_id, 5, "Worker started")

        # Create temp directory for processing
        with tempfile.TemporaryDirectory() as temp_dir:
            # Download video
            report_progress(upload_id, 5, "Downloading video...")
            print(f"[Job {job_id}] Downloading video...")
            video_path = download_video(bucket_name, blob_name, temp_dir)
            report_progress(upload_id, 15, "Extracting frames...")
            
            # Load known exceptions from Memory Layer
            known_exceptions = load_known_exceptions()
            
            # Run analyses based on mode
            if mode == 'quick':
                # Quick mode: minimal analysis with QC Editor persona
                print(f"[Job {job_id}] Running quick analysis...")
                frames = extract_frames_smart(
                    video_path,
                    temp_dir,
                    mode='quick',
                    target_frames=QUICK_MODE_MODEL_FRAMES,
                )
                report_progress(upload_id, 35, "Running quick audio + visual checks...")

                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                    audio_future = executor.submit(analyze_audio, video_path)
                    visual_future = executor.submit(
                        analyze_with_gemini,
                        frames,
                        os.path.basename(blob_name),
                        'quick',
                        known_exceptions,
                    )
                    audio_analysis = None
                    visual_analysis = None
                    for fut in concurrent.futures.as_completed([audio_future, visual_future]):
                        if fut == audio_future:
                            audio_analysis = fut.result()
                            report_progress(upload_id, 55, "Audio checks complete...")
                        else:
                            visual_analysis = fut.result()
                            report_progress(upload_id, 75, "AI visual review complete...")

                    audio_analysis = audio_analysis or {'issues': [], 'summary': 'Audio analysis unavailable'}
                    visual_analysis = visual_analysis or {'issues': [], 'summary': 'Visual analysis unavailable'}
                
            else:
                # Thorough mode: comprehensive analysis with Creative Director persona
                print(f"[Job {job_id}] Running thorough analysis...")
                frames = extract_frames_smart(
                    video_path,
                    temp_dir,
                    mode='thorough',
                    target_frames=THOROUGH_MODE_MODEL_FRAMES,
                )
                report_progress(upload_id, 30, "Running comprehensive technical checks...")

                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                    audio_future = executor.submit(analyze_audio, video_path)
                    video_issues_future = executor.submit(detect_video_issues, video_path)
                    visual_future = executor.submit(
                        analyze_with_gemini,
                        frames,
                        os.path.basename(blob_name),
                        'thorough',
                        known_exceptions,
                    )

                    audio_analysis = None
                    video_issues = None
                    visual_analysis = None
                    futures = [audio_future, video_issues_future, visual_future]
                    for fut in concurrent.futures.as_completed(futures):
                        if fut == audio_future:
                            audio_analysis = fut.result()
                            report_progress(upload_id, 50, "Audio checks complete...")
                        elif fut == video_issues_future:
                            video_issues = fut.result()
                            report_progress(upload_id, 65, "Video integrity scan complete...")
                        else:
                            visual_analysis = fut.result()
                            report_progress(upload_id, 80, "AI visual review complete...")

                    audio_analysis = audio_analysis or {'issues': [], 'summary': 'Audio analysis unavailable'}
                    video_issues = video_issues or []
                    visual_analysis = visual_analysis or {'issues': [], 'summary': 'Visual analysis unavailable'}
                
                # Merge all FFmpeg-detected issues into visual analysis
                visual_analysis['issues'] = (visual_analysis.get('issues', []) or []) + (video_issues or [])

            report_progress(upload_id, 88, "Finalizing findings...")
            
            # Submit results
            report_progress(upload_id, 95, "Submitting results...")
            print(f"[Job {job_id}] Submitting results...")
            submitted = submit_results(upload_id, visual_analysis, audio_analysis, success=True)
            if not submitted:
                mark_deep_analysis_failed(upload_id, "Callback submission failed")
                with jobs_lock:
                    processing_jobs[job_id] = {
                        'status': 'failed',
                        'upload_id': upload_id,
                        'error': 'callback_submission_failed'
                    }
                return
            
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
        mark_deep_analysis_failed(upload_id, f"Analysis failed: {str(e)[:100]}")
        
        # Update job status
        with jobs_lock:
            processing_jobs[job_id] = {
                'status': 'failed',
                'upload_id': upload_id,
                'error': str(e)[:200]
            }
    finally:
        if acquired_slot:
            try:
                job_semaphore.release()
            except ValueError:
                # Shouldn't happen, but don't crash on double-release.
                pass


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

    # Best-effort dedupe: if we've already started work for this upload, skip.
    generation = event_data.get('generation') if isinstance(event_data, dict) else None
    if not acquire_deep_analysis_lock(upload_id, bucket_name, blob_name, job_id, generation):
        return jsonify({'skipped': True, 'reason': 'duplicate event', 'uploadId': upload_id}), 200
    
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
