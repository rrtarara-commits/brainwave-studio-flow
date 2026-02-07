import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';

export function useFrameIOAuth() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  // Check if user has connected Frame.io
  const checkConnection = useCallback(async () => {
    if (!user) {
      setIsConnected(false);
      setIsLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('frameio_oauth_tokens')
        .select('user_id, expires_at')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;

      // Check if token exists and is not expired
      if (data && new Date(data.expires_at) > new Date()) {
        setIsConnected(true);
      } else {
        setIsConnected(false);
      }
    } catch (err) {
      console.error('Error checking Frame.io connection:', err);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Listen for message from popup when auth completes
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      
      if (event.data?.type === 'frameio_auth_complete') {
        setIsConnecting(false);
        checkConnection();
        toast({
          title: 'Connected!',
          description: 'Your Frame.io account is now connected.',
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [checkConnection, toast]);

  // Start OAuth flow - opens in popup to avoid iframe restrictions
  const connect = useCallback(async (returnPath?: string) => {
    setIsConnecting(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('frameio', {
        body: { 
          action: 'get_auth_url',
          redirectUri: `${window.location.origin}/integrations/frameio/callback`,
        },
      });

      if (error) throw error;

      if (data?.success && data?.data?.authUrl) {
        // Store state for CSRF protection
        sessionStorage.setItem('frameio_oauth_state', data.data.state);
        if (returnPath) {
          sessionStorage.setItem('frameio_return_path', returnPath);
        }
        
        // Open in popup window - Adobe IMS blocks iframe embedding
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        
        const popup = window.open(
          data.data.authUrl,
          'frameio_oauth',
          `width=${width},height=${height},left=${left},top=${top},popup=1`
        );
        
        if (!popup) {
          throw new Error('Popup blocked. Please allow popups for this site.');
        }
        
        // Poll to detect when popup closes or redirects back
        const pollTimer = setInterval(() => {
          try {
            // Check if popup was closed
            if (popup.closed) {
              clearInterval(pollTimer);
              setIsConnecting(false);
              // Refresh connection status in case auth completed
              checkConnection();
            }
          } catch (e) {
            // Cross-origin error means we're still on Adobe's domain
          }
        }, 500);
        
      } else {
        throw new Error(data?.error || 'Failed to get authorization URL');
      }
    } catch (err) {
      console.error('Error starting Frame.io OAuth:', err);
      toast({
        variant: 'destructive',
        title: 'Connection Failed',
        description: err instanceof Error ? err.message : 'Failed to start connection',
      });
      setIsConnecting(false);
    }
  }, [toast, checkConnection]);

  // Disconnect Frame.io
  const disconnect = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('frameio', {
        body: { action: 'disconnect' },
      });

      if (error) throw error;

      if (data?.success) {
        setIsConnected(false);
        toast({
          title: 'Disconnected',
          description: 'Frame.io has been disconnected.',
        });
      } else {
        throw new Error(data?.error || 'Failed to disconnect');
      }
    } catch (err) {
      console.error('Error disconnecting Frame.io:', err);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: err instanceof Error ? err.message : 'Failed to disconnect',
      });
    }
  }, [toast]);

  return {
    isConnected,
    isLoading,
    isConnecting,
    connect,
    disconnect,
    refresh: checkConnection,
  };
}
