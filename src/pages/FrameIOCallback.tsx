import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function FrameIOCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('Connecting to Frame.io...');

  // Check if we're in a popup
  const isPopup = window.opener !== null;

  const closeOrRedirect = (path: string) => {
    if (isPopup) {
      // Notify opener and close popup
      try {
        window.opener?.postMessage({ type: 'frameio_auth_complete' }, window.location.origin);
      } catch (e) {
        // Opener may have closed
      }
      window.close();
    } else {
      // Normal redirect for non-popup flow
      navigate(path);
    }
  };

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (error) {
      setStatus('error');
      setMessage(errorDescription || error || 'Authentication failed');
      toast({
        variant: 'destructive',
        title: 'Frame.io Connection Failed',
        description: errorDescription || error,
      });
      setTimeout(() => closeOrRedirect('/projects'), 3000);
      return;
    }

    if (!code) {
      setStatus('error');
      setMessage('No authorization code received');
      setTimeout(() => closeOrRedirect('/projects'), 3000);
      return;
    }

    // Verify state matches what we stored (check both popup and opener sessionStorage)
    let storedState = sessionStorage.getItem('frameio_oauth_state');
    
    // If in popup, state might be in opener's sessionStorage
    if (!storedState && isPopup) {
      try {
        storedState = window.opener?.sessionStorage?.getItem('frameio_oauth_state') || null;
      } catch (e) {
        // Cross-origin, can't access opener's sessionStorage
      }
    }

    if (state !== storedState) {
      setStatus('error');
      setMessage('Security validation failed (state mismatch)');
      setTimeout(() => closeOrRedirect('/projects'), 3000);
      return;
    }

    // Exchange code for tokens
    const exchangeCode = async () => {
      try {
        const { data, error: fnError } = await supabase.functions.invoke('frameio', {
          body: { 
            action: 'exchange_code', 
            code,
            redirectUri: `${window.location.origin}/integrations/frameio/callback`,
          },
        });

        if (fnError) throw fnError;

        if (data?.success) {
          setStatus('success');
          setMessage('Successfully connected to Frame.io!');
          
          // Clear state from both contexts
          sessionStorage.removeItem('frameio_oauth_state');
          try {
            window.opener?.sessionStorage?.removeItem('frameio_oauth_state');
          } catch (e) {
            // Cross-origin
          }
          
          toast({
            title: 'Connected!',
            description: 'Your Frame.io account is now connected.',
          });
          
          setTimeout(() => {
            const returnPath = sessionStorage.getItem('frameio_return_path') || '/projects';
            sessionStorage.removeItem('frameio_return_path');
            closeOrRedirect(returnPath);
          }, 1500);
        } else {
          throw new Error(data?.error || 'Failed to exchange authorization code');
        }
      } catch (err) {
        console.error('Token exchange error:', err);
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Failed to connect to Frame.io');
        toast({
          variant: 'destructive',
          title: 'Connection Failed',
          description: err instanceof Error ? err.message : 'Failed to connect',
        });
        setTimeout(() => closeOrRedirect('/projects'), 3000);
      }
    };

    exchangeCode();
  }, [searchParams, navigate, toast, isPopup]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-8">
        {status === 'processing' && (
          <Loader2 className="h-12 w-12 text-primary animate-spin mx-auto" />
        )}
        {status === 'success' && (
          <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <CheckCircle2 className="h-8 w-8 text-primary" />
          </div>
        )}
        {status === 'error' && (
          <XCircle className="h-12 w-12 text-destructive mx-auto" />
        )}
        <p className="text-lg font-medium">{message}</p>
        {status !== 'processing' && (
          <p className="text-sm text-muted-foreground">
            {isPopup ? 'This window will close...' : 'Redirecting...'}
          </p>
        )}
      </div>
    </div>
  );
}
