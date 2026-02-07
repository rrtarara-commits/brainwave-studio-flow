import { useCallback } from 'react';
import { notionPushApi, ProjectUpdate, WorkLogData } from '@/lib/api/notion-push';
import { useToast } from '@/hooks/use-toast';

export function useNotionPush() {
  const { toast } = useToast();

  const pushProjectUpdate = useCallback(async (
    notionId: string | null,
    updates: ProjectUpdate,
    showToast = false
  ) => {
    if (!notionId) {
      console.log('No Notion ID, skipping push');
      return { success: false, error: 'No Notion ID' };
    }

    try {
      const result = await notionPushApi.pushProjectUpdate(notionId, updates);

      if (result.success) {
        if (showToast) {
          toast({
            title: 'Synced to Notion',
            description: 'Project updated in Notion',
          });
        }
      } else {
        console.error('Failed to push to Notion:', result.error);
        if (showToast) {
          toast({
            variant: 'destructive',
            title: 'Sync failed',
            description: result.error || 'Failed to update Notion',
          });
        }
      }

      return result;
    } catch (error) {
      console.error('Error pushing to Notion:', error);
      return { success: false, error: 'Push failed' };
    }
  }, [toast]);

  const pushWorkLog = useCallback(async (
    workLog: WorkLogData,
    showToast = false
  ) => {
    try {
      const result = await notionPushApi.pushWorkLog(workLog);

      if (result.success) {
        if (showToast) {
          toast({
            title: 'Logged to Notion',
            description: 'Work log added to Notion',
          });
        }
      } else {
        console.error('Failed to push work log to Notion:', result.error);
      }

      return result;
    } catch (error) {
      console.error('Error pushing work log to Notion:', error);
      return { success: false, error: 'Push failed' };
    }
  }, [toast]);

  return {
    pushProjectUpdate,
    pushWorkLog,
  };
}
