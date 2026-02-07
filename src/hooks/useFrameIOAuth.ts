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

  // Start OAuth flow
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
        // Redirect to Adobe login
        window.location.href = data.data.authUrl;
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
  }, [toast]);

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
