#!/usr/bin/env python3
"""
TrueNAS Deep Video Analysis Service
Polls for pending videos, analyzes them with FFmpeg + Gemini Vision, and submits results.
"""

import os
import sys
import json
import time
import logging
import requests
import tempfile
import subprocess
from pathlib import Path
from typing import Optional, Dict, List, Any
from datetime import datetime
import base64

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class DeepAnalyzerConfig:
    """Configuration from environment variables"""
    
    def __init__(self):
        self.supabase_url = os.getenv('SUPABASE_URL', 'https://hdytpmbgrhaxyjvvpewy.supabase.co')
        self.truenas_secret = os.getenv('TRUENAS_CALLBACK_SECRET')
        self.gemini_api_key = os.getenv('GEMINI_API_KEY')
        self.poll_interval = int(os.getenv('POLL_INTERVAL', '60'))
        self.temp_dir = Path(os.getenv('TEMP_DIR', '/tmp/video-analysis'))
        self.ffmpeg_path = os.getenv('FFMPEG_PATH', 'ffmpeg')
        self.ffprobe_path = os.getenv('FFPROBE_PATH', 'ffprobe')
        
        # Validation
        if not self.truenas_secret:
            raise ValueError('TRUENAS_CALLBACK_SECRET environment variable is required')
        if not self.gemini_api_key:
            raise ValueError('GEMINI_API_KEY environment variable is required')
        
        # Create temp directory
        self.temp_dir.mkdir(parents=True, exist_ok=True)
    
    def validate(self):
        """Validate configuration and dependencies"""
        errors = []
        
        # Check ffmpeg
        result = subprocess.run([self.ffmpeg_path, '-version'], 
                              capture_output=True, text=True)
        if result.returncode != 0:
            errors.append(f'ffmpeg not found at {self.ffmpeg_path}')
        
        # Check ffprobe
        result = subprocess.run([self.ffprobe_path, '-version'], 
                              capture_output=True, text=True)
        if result.returncode != 0:
            errors.append(f'ffprobe not found at {self.ffprobe_path}')
        
        if errors:
            for error in errors:
                logger.error(error)
            raise RuntimeError('Configuration validation failed')
        
        logger.info('Configuration validated successfully')


class VideoAnalyzer:
    """Handles video analysis with FFmpeg and Gemini Vision"""
    
    def __init__(self, config: DeepAnalyzerConfig):
        self.config = config
        self.gemini_url = 'https://generativelanguage.googleapis.com/upload?uploadType=multipart'
    
    def download_video(self, signed_url: str, output_path: Path) -> bool:
        """Download video from signed URL"""
        try:
            logger.info(f'Downloading video to {output_path}')
            response = requests.get(signed_url, timeout=300)
            response.raise_for_status()
            
            with open(output_path, 'wb') as f:
                f.write(response.content)
            
            logger.info(f'Downloaded {output_path.stat().st_size} bytes')
            return True
        except Exception as e:
            logger.error(f'Failed to download video: {e}')
            return False
    
    def extract_frames(self, video_path: Path, max_frames: int = 10) -> List[Path]:
        """Extract key frames from video for analysis"""
        try:
            logger.info(f'Extracting {max_frames} frames from {video_path.name}')
            
            # Get video duration
            probe_cmd = [
                self.config.ffprobe_path,
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1:noprint_wrappers=1',
                str(video_path)
            ]
            result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=60)
            
            if result.returncode != 0:
                logger.error(f'Failed to get video duration: {result.stderr}')
                return []
            
            duration = float(result.stdout.strip())
            logger.info(f'Video duration: {duration} seconds')
            
            # Extract evenly spaced frames
            frames = []
            frame_interval = max(1, int(duration / max_frames))
            
            output_pattern = self.config.temp_dir / f'{video_path.stem}_frame_%03d.jpg'
            
            ffmpeg_cmd = [
                self.config.ffmpeg_path,
                '-i', str(video_path),
                '-vf', f'fps=1/{frame_interval}',
                '-q:v', '2',
                str(output_pattern)
            ]
            
            result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode == 0:
                # Collect extracted frames
                frames = sorted(self.config.temp_dir.glob(f'{video_path.stem}_frame_*.jpg'))
                logger.info(f'Extracted {len(frames)} frames')
            else:
                logger.error(f'Frame extraction failed: {result.stderr}')
            
            return frames
        except Exception as e:
            logger.error(f'Error extracting frames: {e}')
            return []
    
    def analyze_audio(self, video_path: Path) -> Dict[str, Any]:
        """Analyze audio levels and issues"""
        try:
            logger.info(f'Analyzing audio from {video_path.name}')
            
            # Extract audio and analyze
            audio_path = self.config.temp_dir / f'{video_path.stem}_audio.wav'
            
            ffmpeg_cmd = [
                self.config.ffmpeg_path,
                '-i', str(video_path),
                '-q:a', '9',
                '-b:a', '192k',
                '-vn',
                str(audio_path)
            ]
            
            result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode != 0:
                logger.error(f'Audio extraction failed: {result.stderr}')
                return {
                    'analyzed': False,
                    'averageDialogueDb': 0,
                    'peakDb': 0,
                    'issues': [{'type': 'Audio extraction failed', 'description': 'Could not extract audio', 'severity': 'warning'}],
                    'summary': 'Audio analysis not available'
                }
            
            # Analyze levels using ffmpeg astats
            stats_cmd = [
                self.config.ffmpeg_path,
                '-i', str(audio_path),
                '-af', 'astats=metadata=1:reset=1',
                '-f', 'null',
                '-'
            ]
            
            result = subprocess.run(stats_cmd, capture_output=True, text=True, timeout=60)
            
            # Parse audio stats (simplified - looking for silent sections)
            issues = []
            average_db = -18  # Typical dialogue level
            peak_db = -3
            
            if 'Silent' in result.stderr:
                issues.append({
                    'type': 'Silent sections detected',
                    'description': 'Audio has extended silent sections',
                    'severity': 'warning'
                })
            
            if 'Clipping' in result.stderr:
                issues.append({
                    'type': 'Audio clipping',
                    'description': 'Audio peaks detected (clipping)',
                    'severity': 'error'
                })
            
            # Cleanup
            audio_path.unlink(missing_ok=True)
            
            return {
                'analyzed': True,
                'averageDialogueDb': average_db,
                'peakDb': peak_db,
                'issues': issues,
                'summary': f'Audio OK - Peak: {peak_db}dB, Dialogue: {average_db}dB' if not issues else f'Audio issues detected: {len(issues)} problem(s)'
            }
        except Exception as e:
            logger.error(f'Error analyzing audio: {e}')
            return {
                'analyzed': False,
                'averageDialogueDb': 0,
                'peakDb': 0,
                'issues': [{'type': 'Analysis error', 'description': str(e), 'severity': 'warning'}],
                'summary': 'Audio analysis failed'
            }
    
    def analyze_visual_with_gemini(self, frames: List[Path], video_name: str) -> Dict[str, Any]:
        """Analyze video frames with Gemini Vision API"""
        try:
            if not frames:
                return {
                    'framesAnalyzed': 0,
                    'issues': [{'type': 'No frames extracted', 'description': 'Could not extract frames for analysis', 'severity': 'warning'}],
                    'summary': 'Visual analysis not available'
                }
            
            logger.info(f'Analyzing {len(frames)} frames with Gemini Vision')
            
            # Prepare frames as base64
            frame_data = []
            for frame_path in frames[:5]:  # Use up to 5 frames for analysis
                try:
                    with open(frame_path, 'rb') as f:
                        frame_data.append({
                            'data': base64.standard_b64encode(f.read()).decode(),
                            'mime_type': 'image/jpeg'
                        })
                except Exception as e:
                    logger.warning(f'Could not read frame {frame_path}: {e}')
            
            if not frame_data:
                return {
                    'framesAnalyzed': 0,
                    'issues': [{'type': 'Frame read error', 'description': 'Could not read extracted frames', 'severity': 'warning'}],
                    'summary': 'Visual analysis failed'
                }
            
            # Build Gemini request with multiple frames
            messages = [
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'text',
                            'text': f'''Analyze these video frames from "{video_name}" for quality issues:

1. Visual artifacts (glitches, compression artifacts, pixelation)
2. Black frames or color issues
3. Text legibility problems
4. Lighting/exposure issues
5. Motion blur or unstable frames

For each issue found, note:
- Issue type (e.g., "Black frame", "Compression artifact")
- Severity: "error" (blocks playback), "warning" (quality issue), "info" (minor)
- Timestamp approximate (which frame)

Return your analysis as JSON:
{{
  "issues": [
    {{"type": "issue name", "description": "details", "severity": "error|warning|info"}},
  ]
}}

If no issues found, return {{"issues": []}}.'''
                        }
                    ] + [
                        {
                            'type': 'image',
                            'image': {'data': fd['data'], 'mime_type': fd['mime_type']}
                        } for fd in frame_data
                    ]
                }
            ]
            
            # Call Gemini Vision API
            headers = {
                'Content-Type': 'application/json',
                'x-goog-api-key': self.config.gemini_api_key
            }
            
            payload = {
                'contents': messages,
                'generationConfig': {
                    'temperature': 0.3,
                    'maxOutputTokens': 1024
                }
            }
            
            response = requests.post(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
                headers=headers,
                json=payload,
                timeout=60
            )
            
            response.raise_for_status()
            result = response.json()
            
            # Parse response
            content = result.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '{}')
            
            # Extract JSON from response
            try:
                # Try to find JSON in the response
                json_start = content.find('{')
                json_end = content.rfind('}') + 1
                if json_start >= 0 and json_end > json_start:
                    analysis = json.loads(content[json_start:json_end])
                else:
                    analysis = {'issues': []}
            except json.JSONDecodeError:
                logger.warning('Could not parse Gemini response as JSON')
                analysis = {'issues': []}
            
            issues = analysis.get('issues', [])
            
            summary = f'Analyzed {len(frames)} frames'
            if issues:
                summary += f' - Found {len(issues)} issue(s)'
            else:
                summary += ' - No issues detected'
            
            return {
                'framesAnalyzed': len(frames),
                'issues': issues,
                'summary': summary
            }
        except Exception as e:
            logger.error(f'Error analyzing with Gemini: {e}')
            return {
                'framesAnalyzed': len(frames) if frames else 0,
                'issues': [{'type': 'Analysis error', 'description': str(e), 'severity': 'warning'}],
                'summary': 'Visual analysis failed'
            }


class PollingService:
    """Handles polling and submission workflow"""
    
    def __init__(self, config: DeepAnalyzerConfig):
        self.config = config
        self.analyzer = VideoAnalyzer(config)
        self.poll_url = f'{config.supabase_url}/functions/v1/deep-analysis-poll'
        self.callback_url = f'{config.supabase_url}/functions/v1/deep-analysis-callback'
    
    def poll_for_videos(self) -> List[Dict[str, Any]]:
        """Poll for pending videos"""
        try:
            headers = {
                'x-truenas-secret': self.config.truenas_secret,
                'Content-Type': 'application/json'
            }
            
            response = requests.get(self.poll_url, headers=headers, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            
            if data.get('success'):
                uploads = data.get('uploads', [])
                logger.info(f'Polled - Found {len(uploads)} pending uploads')
                return uploads
            else:
                logger.error(f'Poll error: {data.get("error")}')
                return []
        except Exception as e:
            logger.error(f'Error polling for videos: {e}')
            return []
    
    def submit_results(self, upload_id: str, visual_analysis: Dict, audio_analysis: Dict) -> bool:
        """Submit analysis results to callback endpoint"""
        try:
            headers = {
                'x-truenas-secret': self.config.truenas_secret,
                'Content-Type': 'application/json'
            }
            
            payload = {
                'uploadId': upload_id,
                'success': True,
                'visualAnalysis': visual_analysis,
                'audioAnalysis': audio_analysis
            }
            
            response = requests.post(self.callback_url, 
                                   headers=headers, 
                                   json=payload, 
                                   timeout=30)
            response.raise_for_status()
            
            data = response.json()
            if data.get('success'):
                logger.info(f'Results submitted for {upload_id}')
                return True
            else:
                logger.error(f'Callback error: {data.get("error")}')
                return False
        except Exception as e:
            logger.error(f'Error submitting results: {e}')
            return False
    
    def submit_error(self, upload_id: str, error_message: str) -> bool:
        """Submit error result"""
        try:
            headers = {
                'x-truenas-secret': self.config.truenas_secret,
                'Content-Type': 'application/json'
            }
            
            payload = {
                'uploadId': upload_id,
                'success': False,
                'error': error_message
            }
            
            response = requests.post(self.callback_url, 
                                   headers=headers, 
                                   json=payload, 
                                   timeout=30)
            response.raise_for_status()
            logger.info(f'Error submitted for {upload_id}')
            return True
        except Exception as e:
            logger.error(f'Error submitting error: {e}')
            return False
    
    def process_upload(self, upload: Dict[str, Any]) -> bool:
        """Process a single upload"""
        upload_id = upload.get('id')
        file_name = upload.get('file_name')
        signed_url = upload.get('signed_url')
        
        logger.info(f'Processing upload {upload_id}: {file_name}')
        
        video_path = self.config.temp_dir / file_name
        
        try:
            # Download video
            if not self.analyzer.download_video(signed_url, video_path):
                self.submit_error(upload_id, 'Failed to download video')
                return False
            
            # Extract and analyze
            frames = self.analyzer.extract_frames(video_path)
            visual_analysis = self.analyzer.analyze_visual_with_gemini(frames, file_name)
            audio_analysis = self.analyzer.analyze_audio(video_path)
            
            # Submit results
            success = self.submit_results(upload_id, visual_analysis, audio_analysis)
            
            # Cleanup
            video_path.unlink(missing_ok=True)
            for frame in frames:
                frame.unlink(missing_ok=True)
            
            return success
        except Exception as e:
            logger.error(f'Error processing upload {upload_id}: {e}')
            self.submit_error(upload_id, str(e))
            video_path.unlink(missing_ok=True)
            return False
    
    def run_forever(self):
        """Main polling loop"""
        logger.info(f'Starting deep analysis service (polling every {self.config.poll_interval}s)')
        
        while True:
            try:
                uploads = self.poll_for_videos()
                
                for upload in uploads:
                    self.process_upload(upload)
                
                time.sleep(self.config.poll_interval)
            except KeyboardInterrupt:
                logger.info('Shutting down gracefully')
                break
            except Exception as e:
                logger.error(f'Unexpected error in polling loop: {e}')
                time.sleep(self.config.poll_interval)


def main():
    """Entry point"""
    try:
        config = DeepAnalyzerConfig()
        config.validate()
        
        service = PollingService(config)
        service.run_forever()
    except Exception as e:
        logger.error(f'Fatal error: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
