import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PROJECT_STATUSES, ProjectStatus } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Save, ArrowRightLeft } from 'lucide-react';

interface StatusMapping {
  [appStatus: string]: string; // maps app status to Notion label
}

export function StatusValueMapping() {
  const { toast } = useToast();
  const [mappings, setMappings] = useState<StatusMapping>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchMappings();
  }, []);

  const fetchMappings = async () => {
    try {
      const { data, error } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'notion_projects_db_status_mapping')
        .single();

      if (error && error.code !== 'PGRST116') throw error;

      if (data?.value) {
        try {
          setMappings(JSON.parse(data.value));
        } catch {
          setMappings({});
        }
      }
    } catch (error) {
      console.error('Error fetching status mappings:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMappingChange = (appStatus: string, notionLabel: string) => {
    setMappings((prev) => ({
      ...prev,
      [appStatus]: notionLabel,
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('app_config')
        .upsert(
          {
            key: 'notion_projects_db_status_mapping',
            value: JSON.stringify(mappings),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'key' }
        );

      if (error) throw error;

      toast({
        title: 'Status mapping saved',
        description: 'Your status labels will be used during sync',
      });
    } catch (error) {
      console.error('Error saving status mappings:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save status mappings',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card className="glass-card">
        <CardContent className="py-8">
          <div className="flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              Status Value Mapping
            </CardTitle>
            <CardDescription>
              Map app statuses to their corresponding Notion labels
            </CardDescription>
          </div>
          <Button
            onClick={handleSave}
            disabled={isSaving}
            size="sm"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Mappings
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter the exact label name used in your Notion Status property for each app status.
            For example, if your Notion uses "Done" instead of "Completed", enter "Done" next to "Completed".
          </p>
          
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PROJECT_STATUSES.map((status) => (
              <div key={status.value} className="space-y-2">
                <Label className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-primary" />
                  {status.label}
                </Label>
                <Input
                  placeholder={`Notion label for "${status.label}"...`}
                  value={mappings[status.value] || ''}
                  onChange={(e) => handleMappingChange(status.value, e.target.value)}
                  className="bg-input"
                />
                <p className="text-xs text-muted-foreground">
                  App value: <code className="text-primary">{status.value}</code>
                </p>
              </div>
            ))}
          </div>

          <div className="p-4 rounded-lg bg-info/10 border border-info/20 mt-6">
            <p className="text-sm text-info">
              <strong>How this works:</strong> When syncing from Notion, the app will convert Notion labels (e.g., "Done") 
              to app statuses (e.g., "completed"). When pushing to Notion, it will do the reverse.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
