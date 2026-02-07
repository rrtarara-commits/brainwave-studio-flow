import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { Plus, Trash2, AlertTriangle, AlertCircle, Info, Loader2 } from 'lucide-react';

interface QCStandard {
  id: string;
  name: string;
  description: string | null;
  category: 'studio' | 'client';
  client_name: string | null;
  rule_type: string;
  rule_config: Record<string, unknown>;
  severity: 'error' | 'warning' | 'info';
  is_active: boolean;
}

export function QCStandardsManager() {
  const { toast } = useToast();
  const [standards, setStandards] = useState<QCStandard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingStandard, setEditingStandard] = useState<QCStandard | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formCategory, setFormCategory] = useState<'studio' | 'client'>('studio');
  const [formClientName, setFormClientName] = useState('');
  const [formRuleType, setFormRuleType] = useState('custom');
  const [formSeverity, setFormSeverity] = useState<'error' | 'warning' | 'info'>('warning');
  const [formRuleConfig, setFormRuleConfig] = useState('{}');

  useEffect(() => {
    fetchStandards();
  }, []);

  const fetchStandards = async () => {
    try {
      const { data, error } = await supabase
        .from('qc_standards')
        .select('*')
        .order('category', { ascending: true })
        .order('name', { ascending: true });

      if (error) throw error;
      setStandards((data || []) as QCStandard[]);
    } catch (error) {
      console.error('Error fetching QC standards:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load QC standards',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormCategory('studio');
    setFormClientName('');
    setFormRuleType('custom');
    setFormSeverity('warning');
    setFormRuleConfig('{}');
    setEditingStandard(null);
  };

  const openEditDialog = (standard: QCStandard) => {
    setEditingStandard(standard);
    setFormName(standard.name);
    setFormDescription(standard.description || '');
    setFormCategory(standard.category);
    setFormClientName(standard.client_name || '');
    setFormRuleType(standard.rule_type);
    setFormSeverity(standard.severity);
    setFormRuleConfig(JSON.stringify(standard.rule_config, null, 2));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast({ variant: 'destructive', title: 'Error', description: 'Name is required' });
      return;
    }

    let ruleConfig = {};
    try {
      ruleConfig = JSON.parse(formRuleConfig);
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Invalid JSON in rule config' });
      return;
    }

    setIsSaving(true);

    try {
      const data = {
        name: formName,
        description: formDescription || null,
        category: formCategory,
        client_name: formCategory === 'client' ? formClientName : null,
        rule_type: formRuleType,
        rule_config: ruleConfig,
        severity: formSeverity,
      };

      if (editingStandard) {
        const { error } = await supabase
          .from('qc_standards')
          .update(data)
          .eq('id', editingStandard.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('qc_standards')
          .insert(data);
        if (error) throw error;
      }

      await fetchStandards();
      setDialogOpen(false);
      resetForm();

      toast({
        title: 'Success',
        description: editingStandard ? 'QC standard updated' : 'QC standard created',
      });
    } catch (error) {
      console.error('Error saving QC standard:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save QC standard',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (standard: QCStandard) => {
    try {
      const { error } = await supabase
        .from('qc_standards')
        .update({ is_active: !standard.is_active })
        .eq('id', standard.id);
      if (error) throw error;

      setStandards(prev =>
        prev.map(s => s.id === standard.id ? { ...s, is_active: !s.is_active } : s)
      );
    } catch (error) {
      console.error('Error toggling standard:', error);
    }
  };

  const handleDelete = async (standard: QCStandard) => {
    if (!confirm('Are you sure you want to delete this QC standard?')) return;

    try {
      const { error } = await supabase
        .from('qc_standards')
        .delete()
        .eq('id', standard.id);
      if (error) throw error;

      setStandards(prev => prev.filter(s => s.id !== standard.id));
      toast({ title: 'Deleted', description: 'QC standard removed' });
    } catch (error) {
      console.error('Error deleting standard:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to delete QC standard',
      });
    }
  };

  const getSeverityIcon = (severity: 'error' | 'warning' | 'info') => {
    switch (severity) {
      case 'error':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'info':
        return <Info className="h-4 w-4 text-blue-500" />;
    }
  };

  const studioStandards = standards.filter(s => s.category === 'studio');
  const clientStandards = standards.filter(s => s.category === 'client');

  return (
    <Card className="glass-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>QC Standards</CardTitle>
            <CardDescription>
              Define quality control rules for video uploads
            </CardDescription>
          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Standard
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  {editingStandard ? 'Edit QC Standard' : 'Add QC Standard'}
                </DialogTitle>
                <DialogDescription>
                  Define a rule to check during video QC analysis
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g., Minimum Resolution Check"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="Describe what this rule checks for..."
                    rows={2}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Select value={formCategory} onValueChange={(v) => setFormCategory(v as 'studio' | 'client')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="studio">Studio-wide</SelectItem>
                        <SelectItem value="client">Client-specific</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Severity</Label>
                    <Select value={formSeverity} onValueChange={(v) => setFormSeverity(v as 'error' | 'warning' | 'info')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="error">Error (blocks submit)</SelectItem>
                        <SelectItem value="warning">Warning</SelectItem>
                        <SelectItem value="info">Info</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {formCategory === 'client' && (
                  <div className="space-y-2">
                    <Label>Client Name</Label>
                    <Input
                      value={formClientName}
                      onChange={(e) => setFormClientName(e.target.value)}
                      placeholder="Enter client name"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Rule Type</Label>
                  <Select value={formRuleType} onValueChange={setFormRuleType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="custom">Custom (AI analyzed)</SelectItem>
                      <SelectItem value="metadata">Metadata check</SelectItem>
                      <SelectItem value="frame">Frame analysis</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Rule Config (JSON)</Label>
                  <Textarea
                    value={formRuleConfig}
                    onChange={(e) => setFormRuleConfig(e.target.value)}
                    placeholder='{"allowed_formats": ["mp4", "mov"]}'
                    rows={3}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    For metadata: allowed_formats, naming_pattern. For custom: AI uses the description.
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {editingStandard ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="skeleton h-16 rounded-lg" />
            ))}
          </div>
        ) : standards.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-8">
            No QC standards defined yet. Add your first standard to get started.
          </p>
        ) : (
          <>
            {/* Studio Standards */}
            {studioStandards.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-3">Studio-wide Standards</h4>
                <div className="space-y-2">
                  {studioStandards.map(standard => (
                    <div
                      key={standard.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => openEditDialog(standard)}
                    >
                      {getSeverityIcon(standard.severity)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{standard.name}</p>
                        {standard.description && (
                          <p className="text-xs text-muted-foreground truncate">
                            {standard.description}
                          </p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {standard.rule_type}
                      </Badge>
                      <Switch
                        checked={standard.is_active}
                        onCheckedChange={() => handleToggleActive(standard)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(standard);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Client Standards */}
            {clientStandards.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-3">Client-specific Standards</h4>
                <div className="space-y-2">
                  {clientStandards.map(standard => (
                    <div
                      key={standard.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => openEditDialog(standard)}
                    >
                      {getSeverityIcon(standard.severity)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{standard.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {standard.client_name} • {standard.description || 'No description'}
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-xs">
                        {standard.client_name}
                      </Badge>
                      <Switch
                        checked={standard.is_active}
                        onCheckedChange={() => handleToggleActive(standard)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(standard);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
