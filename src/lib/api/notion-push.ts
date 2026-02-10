import { invokeBackendFunction } from './invoke-backend-function';

export interface ProjectUpdate {
  status?: string;
  client_budget?: number;
  video_format?: string;
  billable_revisions?: number;
  internal_revisions?: number;
}

export interface WorkLogData {
  hours: number;
  date: string;
  notes?: string;
  taskTypes?: string[];
  projectTitle: string;
  projectNotionId?: string;
}

export const notionPushApi = {
  /**
   * Push a project update to Notion
   * Only works for projects that have a notion_id (were synced from Notion)
   */
  async pushProjectUpdate(notionId: string | null, data: ProjectUpdate) {
    if (!notionId) {
      console.log('Project has no notion_id, skipping Notion push');
      return { success: false, error: 'No notion_id - project not from Notion' };
    }

    try {
      const { data: result, error } = await invokeBackendFunction('notion-push', {
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
  async pushWorkLog(data: WorkLogData) {
    try {
      const { data: result, error } = await invokeBackendFunction('notion-push', {
        body: {
          type: 'work_log',
          data: {
            hours: data.hours,
            logged_at: data.date,
            task_type: data.taskTypes,
            notes: data.notes,
            project_title: data.projectTitle,
          },
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
