-- Create table to store Frame.io OAuth tokens per user
CREATE TABLE public.frameio_oauth_tokens (
  user_id UUID NOT NULL UNIQUE PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  account_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.frameio_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own Frame.io tokens"
ON public.frameio_oauth_tokens FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own Frame.io tokens"
ON public.frameio_oauth_tokens FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own Frame.io tokens"
ON public.frameio_oauth_tokens FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own Frame.io tokens"
ON public.frameio_oauth_tokens FOR DELETE
USING (auth.uid() = user_id);

-- Create trigger for updated_at
CREATE TRIGGER update_frameio_oauth_tokens_updated_at
BEFORE UPDATE ON public.frameio_oauth_tokens
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();