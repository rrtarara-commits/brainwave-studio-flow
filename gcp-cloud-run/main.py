"""
TCV Video QC Analyzer - Cloud Run Service
Event-driven video analysis pipeline using FFmpeg and Vertex AI (Gemini)
"""

import os
import json
import base64
import tempfile
import subprocess
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


def extract_frames(video_path: str, temp_dir: str, num_frames: int = 10) -> list[str]:
    """Extract keyframes from video using FFmpeg."""
    frame_paths = []
    
    # Get video duration
    duration_cmd = [
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        video_path
    ]
    
    try:
        result = subprocess.run(duration_cmd, capture_output=True, text=True, timeout=60)
        duration = float(result.stdout.strip())
    except (subprocess.TimeoutExpired, ValueError):
        duration = 60.0  # Default to 60 seconds if detection fails
    
    # Calculate timestamps for frame extraction
    interval = duration / (num_frames + 1)
    
    for i in range(1, num_frames + 1):
        timestamp = interval * i
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
        '-vf', 'blackdetect=d=0.5:pix_th=0.10',
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
                'category': 'Visual Continuity',
                'title': 'Multiple black frame sequences detected',
                'description': f'Found {len(black_segments)} black segments. Timestamps: {", ".join([f"{t:.1f}s" for t in black_segments[:5]])}{"..." if len(black_segments) > 5 else ""}',
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


def analyze_with_gemini(frame_paths: list[str], file_name: str) -> dict:
    """Analyze frames using Vertex AI Gemini for creative/quality issues."""
    if not frame_paths:
        return {
            'issues': [],
            'summary': 'No frames available for visual analysis'
        }
    
    issues = []
    
    try:
        model = GenerativeModel("gemini-2.0-flash")
        
        # Load frames as base64
        frame_parts = []
        for path in frame_paths[:5]:  # Limit to 5 frames for cost efficiency
            with open(path, 'rb') as f:
                frame_data = f.read()
                frame_parts.append(Part.from_data(frame_data, mime_type="image/jpeg"))
        
        prompt = """You are a professional video QC specialist. Analyze these frames from a video file and identify any quality issues.

Check for:
1. **Visual Glitches**: artifacts, compression issues, banding, blocking
2. **Color Issues**: incorrect white balance, oversaturation, color banding, inconsistent grading
3. **Exposure Problems**: blown highlights, crushed blacks, underexposure
4. **Framing Issues**: unintended letterboxing, aspect ratio problems, off-center subjects
5. **Technical Errors**: interlacing artifacts, frame blending issues

For each issue found, provide:
- Category (e.g., "Color", "Exposure", "Artifacts")
- Severity: "error" (must fix), "warning" (should review), "info" (minor)
- Title: Brief issue name
- Description: What's wrong and how to fix it

Respond in JSON format:
{
  "issues": [
    {
      "category": "string",
      "type": "error|warning|info",
      "title": "string",
      "description": "string"
    }
  ],
  "summary": "Overall quality assessment in one sentence",
  "qualityScore": 1-10
}

If the video looks professional and has no issues, return empty issues array with positive summary."""

        response = model.generate_content([prompt] + frame_parts)
        response_text = response.text
        
        # Parse JSON from response
        try:
            # Try to extract JSON from the response
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


@app.route('/', methods=['POST'])
def handle_gcs_event():
    """Handle GCS Eventarc trigger for new video uploads."""
    
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
    
    # Skip folder objects (folders trigger events too but can't be downloaded)
    if blob_name.endswith('/'):
        print(f"Skipping folder object: {blob_name}")
        return jsonify({'skipped': True, 'reason': 'folder object'}), 200
    
    # Only process video files
    video_extensions = ('.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mxf', '.prores')
    if not blob_name.lower().endswith(video_extensions):
        print(f"Skipping non-video file: {blob_name}")
        return jsonify({'skipped': True, 'reason': 'not a video file'}), 200
    
    # Extract upload ID from path (format: uploads/{upload_id}/{filename} or uploads/{filename})
    path_parts = blob_name.split('/')
    if len(path_parts) >= 3 and path_parts[0] == 'uploads':
        # Format: uploads/{upload_id}/{filename}
        upload_id = path_parts[1]
    elif len(path_parts) >= 2 and path_parts[0] == 'uploads':
        # Format: uploads/{filename} - use filename without extension as ID
        upload_id = os.path.splitext(path_parts[1])[0]
    else:
        # Fallback: use first path part
        upload_id = path_parts[0]
    
    print(f"Processing video: {blob_name} (upload_id: {upload_id})")
    
    # Create temp directory for processing
    with tempfile.TemporaryDirectory() as temp_dir:
        try:
            # Download video
            video_path = download_video(bucket_name, blob_name, temp_dir)
            
            # Run all analyses
            frames = extract_frames(video_path, temp_dir, num_frames=10)
            audio_analysis = analyze_audio(video_path)
            black_frame_issues = detect_black_frames(video_path)
            visual_analysis = analyze_with_gemini(frames, os.path.basename(blob_name))
            
            # Merge black frame issues into visual analysis
            visual_analysis['issues'] = visual_analysis.get('issues', []) + black_frame_issues
            
            # Submit results
            submit_results(upload_id, visual_analysis, audio_analysis, success=True)
            
            return jsonify({
                'success': True,
                'uploadId': upload_id,
                'framesAnalyzed': len(frames),
                'audioIssues': len(audio_analysis.get('issues', [])),
                'visualIssues': len(visual_analysis.get('issues', []))
            })
            
        except Exception as e:
            print(f"Analysis error: {e}")
            submit_results(
                upload_id,
                {'issues': [], 'summary': f'Analysis failed: {str(e)[:100]}'},
                {'issues': [], 'summary': 'Analysis failed'},
                success=False
            )
            return jsonify({'error': str(e)}), 500


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for Cloud Run."""
    return jsonify({'status': 'healthy', 'service': 'tcv-video-analyzer'})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)
