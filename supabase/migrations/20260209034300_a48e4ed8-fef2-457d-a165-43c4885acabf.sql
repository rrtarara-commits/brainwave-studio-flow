-- Fix system_logs unrestricted insert policy
-- Instead of allowing any authenticated user to insert logs,
-- restrict to the authenticated user's own ID via a trigger

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Users can insert own logs" ON public.system_logs;

-- Create a more restrictive policy that binds to authenticated user
-- This ensures the user_id is always set to the authenticated user
CREATE POLICY "Users can insert their own logs"
  ON public.system_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Create a trigger to enforce user_id binding (defense in depth)
CREATE OR REPLACE FUNCTION public.enforce_log_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Always set user_id to the authenticated user (cannot be spoofed)
  NEW.user_id := auth.uid();
  RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS enforce_log_user_id_trigger ON public.system_logs;

-- Create the trigger
CREATE TRIGGER enforce_log_user_id_trigger
  BEFORE INSERT ON public.system_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_log_user_id();