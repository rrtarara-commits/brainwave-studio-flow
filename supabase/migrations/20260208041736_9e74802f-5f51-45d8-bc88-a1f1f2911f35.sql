-- Drop the overly permissive policy
DROP POLICY "Users can view all profiles" ON public.profiles;

-- Users can only see their own profile
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Admins and producers can see all profiles
CREATE POLICY "Admins and producers can view all profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    public.is_admin(auth.uid()) OR 
    public.has_role(auth.uid(), 'producer'::app_role)
  );