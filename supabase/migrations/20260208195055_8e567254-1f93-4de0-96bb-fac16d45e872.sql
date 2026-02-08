-- Add project_code column to projects table
ALTER TABLE public.projects 
ADD COLUMN project_code text;

-- Add a comment describing the format
COMMENT ON COLUMN public.projects.project_code IS 'Standard project code format: 3-4 letters followed by 3 numbers (e.g., ABC123)';