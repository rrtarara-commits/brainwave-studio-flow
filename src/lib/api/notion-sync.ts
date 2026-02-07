import { supabase } from '@/integrations/supabase/client';

export const notionSyncApi = {
  async triggerSync() {
    try {
      const { data, error } = await supabase.functions.invoke('notion-sync');

      if (error) {
        throw error;
      }

      return {
        success: true,
        message: 'Notion sync triggered successfully',
        data,
      };
    } catch (error) {
      console.error('Error triggering Notion sync:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};
