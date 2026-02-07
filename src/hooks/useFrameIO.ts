import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useFrameIOAuth } from './useFrameIOAuth';

export interface FrameIOProject {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  rootAssetId: string;
  accountId?: string;
}

export function useFrameIO() {
  const [projects, setProjects] = useState<FrameIOProject[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { isConnected, isLoading: authLoading, isConnecting, connect, disconnect, refresh: refreshAuth } = useFrameIOAuth();

  const fetchProjects = useCallback(async () => {
    if (!isConnected) {
      setProjects([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('frameio', {
        body: { action: 'get_projects' },
      });

      if (fnError) throw fnError;

      if (data?.success) {
        setProjects(data.data || []);
      } else {
        throw new Error(data?.error || 'Failed to fetch Frame.io projects');
      }
    } catch (err) {
      console.error('Frame.io fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect to Frame.io');
      setProjects([]);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected]);

  const fetchFeedback = async (assetId: string): Promise<string[]> => {
    try {
      const { data, error } = await supabase.functions.invoke('frameio', {
        body: { action: 'get_feedback', assetId },
      });

      if (error) throw error;

      if (data?.success) {
        return data.data;
      }
      return [];
    } catch (err) {
      console.error('Frame.io feedback fetch error:', err);
      return [];
    }
  };

  const fetchAssets = async (frameioProjectId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('frameio', {
        body: { action: 'get_assets', frameioProjectId },
      });

      if (error) throw error;

      if (data?.success) {
        return data.data;
      }
      return [];
    } catch (err) {
      console.error('Frame.io assets fetch error:', err);
      return [];
    }
  };

  // Fetch projects when connected
  useEffect(() => {
    if (isConnected && !authLoading) {
      fetchProjects();
    }
  }, [isConnected, authLoading, fetchProjects]);

  return {
    projects,
    isLoading: isLoading || authLoading,
    error,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    fetchProjects,
    fetchFeedback,
    fetchAssets,
    refreshAuth,
  };
}
