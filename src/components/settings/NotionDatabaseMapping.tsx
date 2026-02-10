import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { notionSchemaApi, NotionProperty } from '@/lib/api/notion-schema';
import { notionSyncApi } from '@/lib/api/notion-sync';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Link,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Database,
} from 'lucide-react';

interface DatabaseConfig {
  key: string;
  label: string;
  description: string;
  value: string;
  expectedFields: ExpectedField[];
}

interface ExpectedField {
  appField: string;
  label: string;
  description: string;
  suggestedType: string;
}

interface PropertyMapping {
  [appField: string]: string; // maps app field to Notion property name
}

const DATABASE_CONFIGS: Omit<DatabaseConfig, 'value'>[] = [
  {
    key: 'notion_projects_db',
    label: 'Projects Database',
    description: 'Main projects tracking database',
    expectedFields: [
      { appField: 'status', label: 'Status', description: 'Project status (active, completed, etc.)', suggestedType: 'status' },
      { appField: 'client_name', label: 'Client Name', description: 'Client or customer name', suggestedType: 'rich_text' },
      { appField: 'client_budget', label: 'Client Budget', description: 'Project budget amount', suggestedType: 'number' },
      { appField: 'video_format', label: 'Video Format', description: 'Type of video deliverable', suggestedType: 'select' },
      { appField: 'billable_revisions', label: 'Billable Revisions', description: 'Number of billable revision rounds', suggestedType: 'number' },
      { appField: 'internal_revisions', label: 'Internal Revisions', description: 'Number of internal revision rounds', suggestedType: 'number' },
    ],
  },
  {
    key: 'notion_team_db',
    label: 'Team Roster Database',
    description: 'Team members and their details',
    expectedFields: [
      { appField: 'email', label: 'Email', description: 'Team member email address', suggestedType: 'email' },
      { appField: 'full_name', label: 'Full Name', description: 'Team member full name', suggestedType: 'rich_text' },
      { appField: 'hourly_rate', label: 'Hourly Rate', description: 'Billing rate per hour', suggestedType: 'number' },
    ],
  },
  {
    key: 'notion_clients_db',
    label: 'Clients Database',
    description: 'Client information and contacts',
    expectedFields: [
      { appField: 'name', label: 'Name', description: 'Client or company name', suggestedType: 'rich_text' },
      { appField: 'contact_email', label: 'Contact Email', description: 'Primary contact email', suggestedType: 'email' },
    ],
  },
  {
    key: 'notion_logs_db',
    label: 'Time Logs Database',
    description: 'Work hours and time tracking (for pushing logs to Notion)',
    expectedFields: [
      { appField: 'hours', label: 'Hours', description: 'Hours worked', suggestedType: 'number' },
      { appField: 'date', label: 'Date', description: 'Date of work', suggestedType: 'date' },
      { appField: 'notes', label: 'Notes', description: 'Work description or notes', suggestedType: 'rich_text' },
    ],
  },
];

export function NotionDatabaseMapping() {
  const { toast } = useToast();
  const [configs, setConfigs] = useState<DatabaseConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [schemas, setSchemas] = useState<Record<string, NotionProperty[]>>({});
  const [loadingSchemas, setLoadingSchemas] = useState<Set<string>>(new Set());
  const [mappings, setMappings] = useState<Record<string, PropertyMapping>>({});
  
  // Create property dialog state
  const [createDialog, setCreateDialog] = useState<{
    open: boolean;
    dbKey: string;
    appField: string;
    suggestedName: string;
    suggestedType: string;
  } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState('');

  const fetchConfigs = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('app_config')
        .select('*')
        .order('key');

      if (error) throw error;

      // Merge with expected configs
      const mergedConfigs: DatabaseConfig[] = DATABASE_CONFIGS.map((dc) => {
        const existing = (data || []).find((d: any) => d.key === dc.key);
        return {
          ...dc,
          value: existing?.value || '',
        };
      });

      setConfigs(mergedConfigs);

      // Load saved mappings
      const mappingConfigs = (data || []).filter((d: any) => d.key.endsWith('_mapping'));
      const loadedMappings: Record<string, PropertyMapping> = {};
      for (const mc of mappingConfigs) {
        try {
          const baseKey = mc.key.replace('_mapping', '');
          loadedMappings[baseKey] = JSON.parse(mc.value);
        } catch {
          // Ignore parse errors
        }
      }
      setMappings(loadedMappings);
    } catch (error) {
      console.error('Error fetching config:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load configuration',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const handleDatabaseIdChange = async (key: string, value: string) => {
    setConfigs((prev) =>
      prev.map((c) => (c.key === key ? { ...c, value } : c))
    );

    // Clear schema when ID changes
    setSchemas((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const saveDatabaseId = async (key: string, value: string) => {
    try {
      const { error } = await supabase
        .from('app_config')
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

      if (error) throw error;

      toast({
        title: 'Saved',
        description: 'Database ID saved successfully',
      });

      // Auto-fetch schema if we have a valid ID
      if (value.length >= 32) {
        fetchSchema(key, value);
      }
    } catch (error) {
      console.error('Error saving config:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save database ID',
      });
    }
  };

  const fetchSchema = async (key: string, databaseId: string) => {
    if (!databaseId || databaseId.length < 32) {
      toast({
        variant: 'destructive',
        title: 'Invalid ID',
        description: 'Please enter a valid Notion Database ID',
      });
      return;
    }

    setLoadingSchemas((prev) => new Set(prev).add(key));

    try {
      const result = await notionSchemaApi.getSchema(databaseId);

      if (result.success) {
        setSchemas((prev) => ({ ...prev, [key]: result.properties }));
        setExpandedDbs((prev) => new Set(prev).add(key));
        toast({
          title: 'Schema loaded',
          description: `Found ${result.properties.length} properties`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Failed to load schema',
          description: result.error || 'Could not fetch database properties',
        });
      }
    } catch (error) {
      console.error('Error fetching schema:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to fetch Notion schema',
      });
    } finally {
      setLoadingSchemas((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleMappingChange = async (dbKey: string, appField: string, notionProperty: string) => {
    const newMappings = {
      ...mappings,
      [dbKey]: {
        ...(mappings[dbKey] || {}),
        [appField]: notionProperty,
      },
    };
    setMappings(newMappings);

    // Save to database
    try {
      const { error } = await supabase
        .from('app_config')
        .upsert(
          {
            key: `${dbKey}_mapping`,
            value: JSON.stringify(newMappings[dbKey]),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'key' }
        );

      if (error) throw error;
    } catch (error) {
      console.error('Error saving mapping:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save property mapping',
      });
    }
  };

  const openCreateDialog = (dbKey: string, appField: string, suggestedName: string, suggestedType: string) => {
    setNewPropertyName(suggestedName);
    setCreateDialog({
      open: true,
      dbKey,
      appField,
      suggestedName,
      suggestedType,
    });
  };

  const handleCreateProperty = async () => {
    if (!createDialog || !newPropertyName.trim()) return;

    const config = configs.find((c) => c.key === createDialog.dbKey);
    if (!config?.value) return;

    setIsCreating(true);

    try {
      const result = await notionSchemaApi.createProperty(
        config.value,
        newPropertyName.trim(),
        createDialog.suggestedType
      );

      if (result.success) {
        toast({
          title: 'Property created',
          description: `"${newPropertyName}" was created in Notion`,
        });

        // Refresh schema and auto-map
        await fetchSchema(createDialog.dbKey, config.value);
        handleMappingChange(createDialog.dbKey, createDialog.appField, newPropertyName.trim());
        setCreateDialog(null);
      } else {
        toast({
          variant: 'destructive',
          title: 'Failed to create property',
          description: result.error || 'Unknown error',
        });
      }
    } catch (error) {
      console.error('Error creating property:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to create property in Notion',
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const result = await notionSyncApi.triggerSync();
      
      if (result.success) {
        toast({
          title: 'Sync complete',
          description: result.data?.message || 'Data synced successfully',
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Sync failed',
          description: result.error || 'Failed to sync',
        });
      }
    } catch (error) {
      console.error('Sync error:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to trigger sync',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const toggleExpanded = (key: string) => {
    setExpandedDbs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <Card className="glass-card">
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Link className="h-5 w-5 text-primary" />
                Notion Database Mapping
              </CardTitle>
              <CardDescription>
                Connect your Notion databases and map properties to app fields
              </CardDescription>
            </div>
            <Button
              onClick={handleSync}
              disabled={isSyncing}
              variant="outline"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Sync All
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {configs.map((config) => {
            const isExpanded = expandedDbs.has(config.key);
            const isLoadingSchema = loadingSchemas.has(config.key);
            const schema = schemas[config.key] || [];
            const dbMappings = mappings[config.key] || {};
            const hasValidId = config.value.length >= 32;

            return (
              <Collapsible
                key={config.key}
                open={isExpanded}
                onOpenChange={() => hasValidId && schema.length > 0 && toggleExpanded(config.key)}
              >
                <div className="border rounded-lg p-4 bg-card/50">
                  {/* Database Header */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-muted-foreground" />
                      <Label className="font-medium">{config.label}</Label>
                    </div>
                    <p className="text-xs text-muted-foreground">{config.description}</p>
                    
                    <div className="flex gap-2">
                      <Input
                        placeholder="Paste Notion Database ID..."
                        value={config.value}
                        onChange={(e) => handleDatabaseIdChange(config.key, e.target.value)}
                        onBlur={() => config.value && saveDatabaseId(config.key, config.value)}
                        className="bg-input border-border font-mono text-sm"
                      />
                      <Button
                        variant="outline"
                        onClick={() => fetchSchema(config.key, config.value)}
                        disabled={isLoadingSchema || !hasValidId}
                        className="shrink-0"
                      >
                        {isLoadingSchema ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : schema.length > 0 ? (
                          <CheckCircle className="h-4 w-4 text-success" />
                        ) : (
                          'Connect'
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Expandable Property Mappings */}
                  {schema.length > 0 && (
                    <>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full mt-4 justify-between hover:bg-muted/50"
                        >
                          <span className="text-sm text-muted-foreground">
                            {Object.keys(dbMappings).length} of {config.expectedFields.length} fields mapped
                          </span>
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </CollapsibleTrigger>

                      <CollapsibleContent className="mt-4 space-y-3 pl-6 border-l-2 border-muted ml-2">
                        {config.expectedFields.map((field) => (
                          <div key={field.appField} className="space-y-1">
                            <Label className="text-sm">{field.label}</Label>
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                            <Select
                              value={dbMappings[field.appField] || ''}
                              onValueChange={(value) => {
                                if (value === '__create_new__') {
                                  openCreateDialog(
                                    config.key,
                                    field.appField,
                                    field.label.replace(/\s+/g, ' '),
                                    field.suggestedType
                                  );
                                } else {
                                  handleMappingChange(config.key, field.appField, value);
                                }
                              }}
                            >
                              <SelectTrigger className="bg-input">
                                <SelectValue placeholder="Select Notion property..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__create_new__">
                                  <span className="flex items-center gap-2 text-primary">
                                    <Plus className="h-3 w-3" />
                                    Create new property
                                  </span>
                                </SelectItem>
                                {schema.map((prop) => (
                                  <SelectItem key={prop.id} value={prop.name}>
                                    <span className="flex items-center gap-2">
                                      {prop.name}
                                      <span className="text-xs text-muted-foreground">
                                        ({prop.type})
                                      </span>
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </CollapsibleContent>
                    </>
                  )}
                </div>
              </Collapsible>
            );
          })}

          <div className="p-4 rounded-lg bg-info/10 border border-info/20">
            <p className="text-sm text-info">
              <strong>How to find Database IDs:</strong> Open your Notion database → Click "Share" → Copy the link. The ID is the 32-character string before the "?v=" parameter.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Create Property Dialog */}
      <Dialog open={createDialog?.open || false} onOpenChange={(open) => !open && setCreateDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Notion Property</DialogTitle>
            <DialogDescription>
              Create a new property in your Notion database and map it to this field.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Property Name</Label>
              <Input
                value={newPropertyName}
                onChange={(e) => setNewPropertyName(e.target.value)}
                placeholder="Enter property name..."
              />
            </div>
            <div className="space-y-2">
              <Label>Property Type</Label>
              <p className="text-sm text-muted-foreground">
                Will be created as: <strong>{createDialog?.suggestedType}</strong>
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialog(null)}>
              Cancel
            </Button>
            <Button onClick={handleCreateProperty} disabled={isCreating || !newPropertyName.trim()}>
              {isCreating ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Create & Map
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
