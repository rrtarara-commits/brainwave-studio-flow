import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface FrameIOProject {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  rootAssetId: string;
}

export function useFrameIO() {
  const [projects, setProjects] = useState<FrameIOProject[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: fnError } = await supabase.functions.invoke('frameio', {
        body: { action: 'get_projects' },
      });

      if (fnError) throw fnError;

      if (data?.success) {
        setProjects(data.data);
      } else {
        throw new Error(data?.error || 'Failed to fetch Frame.io projects');
      }
    } catch (err) {
      console.error('Frame.io fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect to Frame.io');
    } finally {
      setIsLoading(false);
    }
  };

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

  useEffect(() => {
    fetchProjects();
  }, []);

  return {
    projects,
    isLoading,
    error,
    fetchProjects,
    fetchFeedback,
    fetchAssets,
  };
}
