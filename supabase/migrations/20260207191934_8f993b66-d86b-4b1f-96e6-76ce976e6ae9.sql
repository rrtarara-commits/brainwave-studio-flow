-- Create storage bucket for video uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('video-uploads', 'video-uploads', false);

-- Storage policies for video uploads
CREATE POLICY "Users can upload videos"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'video-uploads' 
  AND auth.uid() IS NOT NULL
);

CREATE POLICY "Users can view their own video uploads"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'video-uploads' 
  AND auth.uid() IS NOT NULL
);

CREATE POLICY "Users can delete their own video uploads"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'video-uploads' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);