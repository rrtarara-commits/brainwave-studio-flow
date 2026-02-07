-- QC Standards table (synced from Notion, studio-wide and client-specific)
CREATE TABLE public.qc_standards (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('studio', 'client')),
  client_name TEXT, -- NULL for studio-wide, client name for client-specific
  rule_type TEXT NOT NULL, -- 'metadata', 'frame', 'custom'
  rule_config JSONB NOT NULL DEFAULT '{}', -- e.g., {"min_resolution": "1920x1080", "max_duration": 300}
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('error', 'warning', 'info')),
  notion_source_id TEXT, -- Reference to Notion database/page
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Video uploads table for tracking QC and Frame.io status
CREATE TABLE public.video_uploads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT,
  storage_path TEXT, -- Path in Supabase storage
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'analyzing', 'reviewed', 'uploading', 'completed', 'failed')),
  
  -- QC Analysis results
  qc_result JSONB, -- Full AI analysis with flags
  qc_passed BOOLEAN,
  dismissed_flags TEXT[], -- Flag IDs editor chose to dismiss
  
  -- Frame.io integration
  frameio_project_id TEXT,
  frameio_asset_id TEXT,
  frameio_link TEXT,
  frameio_feedback JSONB, -- Cached feedback from Frame.io
  
  -- Timestamps
  analyzed_at TIMESTAMP WITH TIME ZONE,
  submitted_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add Frame.io link column to projects
ALTER TABLE public.projects 
ADD COLUMN frameio_link TEXT,
ADD COLUMN frameio_project_id TEXT;

-- Enable RLS
ALTER TABLE public.qc_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_uploads ENABLE ROW LEVEL SECURITY;

-- QC Standards policies (viewable by all, editable by admins)
CREATE POLICY "Authenticated users can view QC standards"
ON public.qc_standards FOR SELECT
USING (true);

CREATE POLICY "Admins can manage QC standards"
ON public.qc_standards FOR ALL
USING (is_admin(auth.uid()));

-- Video uploads policies
CREATE POLICY "Users can view uploads for their projects"
ON public.video_uploads FOR SELECT
USING (
  uploader_id = auth.uid() 
  OR is_admin(auth.uid()) 
  OR has_role(auth.uid(), 'producer'::app_role)
);

CREATE POLICY "Users can create uploads"
ON public.video_uploads FOR INSERT
WITH CHECK (auth.uid() = uploader_id);

CREATE POLICY "Users can update their own uploads"
ON public.video_uploads FOR UPDATE
USING (uploader_id = auth.uid() OR is_admin(auth.uid()));

-- Indexes
CREATE INDEX idx_qc_standards_category ON public.qc_standards(category);
CREATE INDEX idx_qc_standards_client ON public.qc_standards(client_name);
CREATE INDEX idx_video_uploads_project ON public.video_uploads(project_id);
CREATE INDEX idx_video_uploads_status ON public.video_uploads(status);

-- Triggers
CREATE TRIGGER update_qc_standards_updated_at
BEFORE UPDATE ON public.qc_standards
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_video_uploads_updated_at
BEFORE UPDATE ON public.video_uploads
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();