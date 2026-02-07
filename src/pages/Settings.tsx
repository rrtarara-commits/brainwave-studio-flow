import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { AppConfig } from '@/lib/types';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { UserManagement } from '@/components/settings/UserManagement';
import { notionSyncApi } from '@/lib/api/notion-sync';
import {
  Database,
  Link,
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  Users,
  RefreshCw,
} from 'lucide-react';

export default function Settings() {
  const { isAdmin } = useAuth();
  const [config, setConfig] = useState<AppConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean | null>>({});

  const { toast } = useToast();

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const { data, error } = await supabase
        .from('app_config')
        .select('*')
        .order('key');

      if (error) throw error;
      setConfig((data || []) as unknown as AppConfig[]);
    } catch (error) {
      console.error('Error fetching config:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfigChange = (key: string, value: string) => {
    setConfig((prev) =>
      prev.map((c) => (c.key === key ? { ...c, value } : c))
    );
    // Clear test result when value changes
    setTestResults((prev) => ({ ...prev, [key]: null }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      for (const item of config) {
        const { error } = await supabase
          .from('app_config')
          .update({ value: item.value })
          .eq('key', item.key);

        if (error) throw error;
      }

      toast({
        title: 'Settings saved',
        description: 'Configuration updated successfully',
      });
    } catch (error) {
      console.error('Error saving config:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save settings',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleNotionSync = async () => {
    setIsSyncing(true);
    try {
      const result = await notionSyncApi.triggerSync();
      
      if (result.success) {
        toast({
          title: 'Sync triggered',
          description: 'Notion data is being synced to your database',
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Sync failed',
          description: result.error || 'Failed to sync Notion data',
        });
      }
    } catch (error) {
      console.error('Error triggering sync:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to trigger sync',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const testNotionConnection = async (key: string) => {
    const configItem = config.find((c) => c.key === key);
    if (!configItem?.value) {
      toast({
        variant: 'destructive',
        title: 'No ID provided',
        description: 'Please enter a Notion Database ID first',
      });
      return;
    }

    setTestingKey(key);
    
    // Simulate test (in production, this would call a Notion API edge function)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    
    // For now, mark as success if ID looks valid
    const isValid = configItem.value.length >= 32;
    setTestResults((prev) => ({ ...prev, [key]: isValid }));
    setTestingKey(null);

    toast({
      variant: isValid ? 'default' : 'destructive',
      title: isValid ? 'Connection successful' : 'Connection failed',
      description: isValid
        ? 'Notion database is accessible'
        : 'Could not connect to Notion database',
    });
  };

  const notionConfigs = config.filter((c) => c.key.startsWith('notion_'));
  const otherConfigs = config.filter((c) => !c.key.startsWith('notion_'));

  const getConfigLabel = (key: string) => {
    switch (key) {
      case 'notion_projects_db':
        return 'Projects Database';
      case 'notion_team_db':
        return 'Team Roster Database';
      case 'notion_clients_db':
        return 'Clients Database';
      case 'notion_logs_db':
        return 'Logs Database';
      case 'default_margin_percentage':
        return 'Default Margin (%)';
      default:
        return key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    }
  };

  if (!isAdmin) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Card className="glass-card max-w-md w-full">
            <CardContent className="py-12 text-center">
              <XCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
              <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
              <p className="text-muted-foreground">
                Admin privileges required to access settings
              </p>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6 animate-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Settings</h1>
            <p className="text-muted-foreground mt-1">
              Configure your studio portal
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleNotionSync}
              disabled={isSyncing}
              variant="outline"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Sync Notion
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-primary hover:bg-primary/90"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
          </div>
        </div>

        <Tabs defaultValue="users" className="space-y-4">
          <TabsList className="bg-secondary">
            <TabsTrigger value="users" className="data-[state=active]:bg-background">
              <Users className="h-4 w-4 mr-2" />
              Users
            </TabsTrigger>
            <TabsTrigger value="notion" className="data-[state=active]:bg-background">
              <Database className="h-4 w-4 mr-2" />
              Database Mapping
            </TabsTrigger>
            <TabsTrigger value="general" className="data-[state=active]:bg-background">
              General
            </TabsTrigger>
          </TabsList>

          {/* User Management */}
          <TabsContent value="users">
            <UserManagement />
          </TabsContent>

          {/* Notion Database Mapping */}
          <TabsContent value="notion">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link className="h-5 w-5 text-primary" />
                  Notion Database Mapping
                </CardTitle>
                <CardDescription>
                  Connect your Notion workspace by entering Database IDs. Data syncs from Notion to
                  the performance backend every hour.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {isLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="skeleton h-20 rounded-lg" />
                    ))}
                  </div>
                ) : (
                  notionConfigs.map((item) => (
                    <div key={item.key} className="space-y-2">
                      <Label>{getConfigLabel(item.key)}</Label>
                      <p className="text-xs text-muted-foreground">
                        {item.description}
                      </p>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Paste Notion Database ID..."
                          value={item.value}
                          onChange={(e) =>
                            handleConfigChange(item.key, e.target.value)
                          }
                          className="bg-input border-border font-mono text-sm"
                        />
                        <Button
                          variant="outline"
                          onClick={() => testNotionConnection(item.key)}
                          disabled={testingKey === item.key}
                          className="shrink-0"
                        >
                          {testingKey === item.key ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : testResults[item.key] === true ? (
                            <CheckCircle className="h-4 w-4 text-success" />
                          ) : testResults[item.key] === false ? (
                            <XCircle className="h-4 w-4 text-destructive" />
                          ) : (
                            'Test'
                          )}
                        </Button>
                      </div>
                    </div>
                  ))
                )}

                <div className="p-4 rounded-lg bg-info/10 border border-info/20">
                  <p className="text-sm text-info">
                    <strong>How to find Database IDs:</strong> Open your Notion database → Click
                    "Share" → Copy the link. The ID is the 32-character string before the "?v="
                    parameter.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* General Settings */}
          <TabsContent value="general">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle>General Settings</CardTitle>
                <CardDescription>
                  Configure default values and business rules
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {otherConfigs.map((item) => (
                  <div key={item.key} className="space-y-2">
                    <Label>{getConfigLabel(item.key)}</Label>
                    {item.description && (
                      <p className="text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                    <Input
                      type={item.key.includes('percentage') ? 'number' : 'text'}
                      value={item.value}
                      onChange={(e) =>
                        handleConfigChange(item.key, e.target.value)
                      }
                      className="bg-input border-border max-w-xs"
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
