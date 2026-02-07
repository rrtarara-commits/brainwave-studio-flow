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
import { NotionDatabaseMapping } from '@/components/settings/NotionDatabaseMapping';
import { StatusValueMapping } from '@/components/settings/StatusValueMapping';
import { SyncStatusIndicator } from '@/components/settings/SyncStatusIndicator';
import {
  Database,
  XCircle,
  Loader2,
  Save,
  Users,
} from 'lucide-react';

export default function Settings() {
  const { isAdmin } = useAuth();
  const [config, setConfig] = useState<AppConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Only save non-notion configs (notion is handled by the mapping component)
      const nonNotionConfigs = config.filter((c) => !c.key.startsWith('notion_'));
      
      for (const item of nonNotionConfigs) {
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

  const otherConfigs = config.filter(
    (c) => !c.key.startsWith('notion_') && !c.key.endsWith('_mapping')
  );

  const getConfigLabel = (key: string) => {
    switch (key) {
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
          {otherConfigs.length > 0 && (
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
          )}
        </div>

        <Tabs defaultValue="notion" className="space-y-4">
          <TabsList className="bg-secondary">
            <TabsTrigger value="notion" className="data-[state=active]:bg-background">
              <Database className="h-4 w-4 mr-2" />
              Database Mapping
            </TabsTrigger>
            <TabsTrigger value="users" className="data-[state=active]:bg-background">
              <Users className="h-4 w-4 mr-2" />
              Users
            </TabsTrigger>
            <TabsTrigger value="general" className="data-[state=active]:bg-background">
              General
            </TabsTrigger>
          </TabsList>

          {/* Notion Database Mapping */}
          <TabsContent value="notion" className="space-y-6">
            <SyncStatusIndicator />
            <NotionDatabaseMapping />
            <StatusValueMapping />
          </TabsContent>

          {/* User Management */}
          <TabsContent value="users">
            <UserManagement />
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
                {isLoading ? (
                  <div className="space-y-4">
                    {[1, 2].map((i) => (
                      <div key={i} className="skeleton h-16 rounded-lg" />
                    ))}
                  </div>
                ) : otherConfigs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No general settings configured yet.
                  </p>
                ) : (
                  otherConfigs.map((item) => (
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
                  ))
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
