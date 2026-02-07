import { supabase } from '@/integrations/supabase/client';

interface PushProjectData {
  status?: string;
  client_budget?: number;
  video_format?: string;
}

interface PushWorkLogData {
  hours: number;
  logged_at: string;
  task_type?: string[];
  notes?: string;
  project_title: string;
}

export const notionPushApi = {
  /**
   * Push a project update to Notion
   * Only works for projects that have a notion_id (were synced from Notion)
   */
  async pushProjectUpdate(notionId: string | null, data: PushProjectData) {
    if (!notionId) {
      console.log('Project has no notion_id, skipping Notion push');
      return { success: false, error: 'No notion_id - project not from Notion' };
    }

    try {
      const { data: result, error } = await supabase.functions.invoke('notion-push', {
        body: {
          type: 'project',
          notion_id: notionId,
          data,
        },
      });

      if (error) throw error;

      return {
        success: result?.success ?? false,
        error: result?.error,
      };
    } catch (error) {
      console.error('Error pushing to Notion:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },

  /**
   * Push a new work log entry to Notion
   * Requires notion_logs_db to be configured in app_config
   */
  async pushWorkLog(data: PushWorkLogData) {
    try {
      const { data: result, error } = await supabase.functions.invoke('notion-push', {
        body: {
          type: 'work_log',
          data,
        },
      });

      if (error) throw error;

      return {
        success: result?.success ?? false,
        pageId: result?.pageId,
        error: result?.error,
      };
    } catch (error) {
      console.error('Error pushing work log to Notion:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};
