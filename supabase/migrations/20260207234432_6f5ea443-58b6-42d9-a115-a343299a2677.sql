-- Add columns to video_uploads for deep analysis tracking
ALTER TABLE public.video_uploads
ADD COLUMN deep_analysis_status TEXT DEFAULT 'none' CHECK (deep_analysis_status IN ('none', 'pending', 'processing', 'completed', 'failed')),
ADD COLUMN visual_analysis JSONB,
ADD COLUMN audio_analysis JSONB,
ADD COLUMN signed_url TEXT,
ADD COLUMN signed_url_expires_at TIMESTAMP WITH TIME ZONE;

-- Create index for efficient polling by TrueNAS
CREATE INDEX idx_video_uploads_deep_analysis_status ON public.video_uploads(deep_analysis_status) 
WHERE deep_analysis_status = 'pending';