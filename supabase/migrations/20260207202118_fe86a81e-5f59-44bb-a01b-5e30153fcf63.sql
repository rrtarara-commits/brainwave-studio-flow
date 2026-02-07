-- Fix system_logs INSERT policy to prevent log forging
-- Drop the insecure policy that allows any user to insert logs with any user_id
DROP POLICY IF EXISTS "System can insert logs" ON public.system_logs;

-- Create a trigger to enforce that user_id is set to the authenticated user
CREATE OR REPLACE FUNCTION public.enforce_log_user_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Always set user_id to the authenticated user (cannot be spoofed)
  NEW.user_id := auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS enforce_log_user_id_trigger ON public.system_logs;

CREATE TRIGGER enforce_log_user_id_trigger
  BEFORE INSERT ON public.system_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_log_user_id();

-- Create new INSERT policy that allows authenticated users to insert logs
-- The trigger ensures user_id is always set correctly
CREATE POLICY "Users can insert own logs"
  ON public.system_logs FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Fix storage SELECT policy to restrict viewing to own uploads or admin/producer roles
-- Drop the overly permissive SELECT policy
DROP POLICY IF EXISTS "Users can view their own video uploads" ON storage.objects;

-- Create properly restrictive SELECT policy
CREATE POLICY "Users can view own or role-based video uploads"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'video-uploads' AND (
    -- User owns the folder (uploader)
    auth.uid()::text = (storage.foldername(name))[1]
    OR
    -- User is admin
    public.is_admin(auth.uid())
    OR
    -- User is producer
    public.has_role(auth.uid(), 'producer'::app_role)
  )
);