ALTER TABLE video_uploads 
ADD COLUMN deep_analysis_progress jsonb DEFAULT '{"percent": 0, "stage": "pending"}'::jsonb;