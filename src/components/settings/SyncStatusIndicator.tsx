import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { notionSyncApi } from '@/lib/api/notion-sync';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface SyncStatusIndicatorProps {
  compact?: boolean;
  onSyncComplete?: () => void;
}

export function SyncStatusIndicator({ compact = false, onSyncComplete }: SyncStatusIndicatorProps) {
  const { toast } = useToast();
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<'success' | 'error' | null>(null);

  useEffect(() => {
    fetchLastSyncTime();
  }, []);

  const fetchLastSyncTime = async () => {
    try {
      const { data, error } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'last_notion_sync')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      
      if (data?.value) {
        setLastSyncTime(data.value);
      }
    } catch (error) {
      console.error('Error fetching last sync time:', error);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncResult(null);

    try {
      const result = await notionSyncApi.triggerSync();

      if (result.success) {
        setSyncResult('success');
        setLastSyncTime(new Date().toISOString());
        toast({
          title: 'Sync complete',
          description: result.data?.message || 'Data synced from Notion',
        });
        onSyncComplete?.();
      } else {
        setSyncResult('error');
        toast({
          variant: 'destructive',
          title: 'Sync failed',
          description: result.error || 'Failed to sync with Notion',
        });
      }
    } catch (error) {
      console.error('Sync error:', error);
      setSyncResult('error');
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to trigger sync',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const formatLastSync = () => {
    if (!lastSyncTime) return 'Never synced';
    try {
      return `Last synced ${formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}`;
    } catch {
      return 'Unknown';
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSync}
          disabled={isSyncing}
          className="h-8"
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${isSyncing ? 'animate-spin' : ''}`} />
          Sync
        </Button>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatLastSync()}
        </span>
      </div>
    );
  }

  return (
    <Card className="glass-card">
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {syncResult === 'success' ? (
              <CheckCircle className="h-5 w-5 text-success" />
            ) : syncResult === 'error' ? (
              <AlertCircle className="h-5 w-5 text-destructive" />
            ) : (
              <Clock className="h-5 w-5 text-muted-foreground" />
            )}
            <div>
              <p className="text-sm font-medium">Notion Sync Status</p>
              <p className="text-xs text-muted-foreground">{formatLastSync()}</p>
            </div>
          </div>
          <Button
            onClick={handleSync}
            disabled={isSyncing}
            variant="outline"
            size="sm"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync Now'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
