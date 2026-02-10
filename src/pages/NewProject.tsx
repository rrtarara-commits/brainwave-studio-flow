import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { AppLayout } from '@/components/layout/AppLayout';
import { PROJECT_STATUSES, ProjectStatus } from '@/lib/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Loader2, Plus } from 'lucide-react';

const PROJECT_CODE_PATTERN = /^[A-Za-z]{3,4}\d{3}$/;

export default function NewProject() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [title, setTitle] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientBudget, setClientBudget] = useState('');
  const [videoFormat, setVideoFormat] = useState('');
  const [projectCode, setProjectCode] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('active');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast({
        variant: 'destructive',
        title: 'Title required',
        description: 'Please enter a project title.',
      });
      return;
    }

    const trimmedProjectCode = projectCode.trim().toUpperCase();
    if (trimmedProjectCode && !PROJECT_CODE_PATTERN.test(trimmedProjectCode)) {
      toast({
        variant: 'destructive',
        title: 'Invalid project code',
        description: 'Use format like ABC123 or ABCD123.',
      });
      return;
    }

    const parsedBudget = clientBudget.trim() ? Number(clientBudget) : 0;
    if (Number.isNaN(parsedBudget) || parsedBudget < 0) {
      toast({
        variant: 'destructive',
        title: 'Invalid budget',
        description: 'Budget must be a positive number.',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.from('projects').insert({
        title: trimmedTitle,
        status,
        client_name: clientName.trim() || null,
        client_budget: parsedBudget,
        video_format: videoFormat.trim() || null,
        project_code: trimmedProjectCode || null,
      });

      if (error) throw error;

      toast({
        title: 'Project created',
        description: `${trimmedTitle} was added successfully.`,
      });
      navigate('/projects');
    } catch (error) {
      console.error('Error creating project:', error);
      toast({
        variant: 'destructive',
        title: 'Creation failed',
        description: 'Could not create project. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="max-w-2xl space-y-6 animate-in">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/projects')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">New Project</h1>
            <p className="text-muted-foreground mt-1">Create a new production project</p>
          </div>
        </div>

        <Card className="glass-card">
          <CardHeader>
            <CardTitle>Project Details</CardTitle>
            <CardDescription>Fill in the essentials to get this project started.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Summer Campaign Launch"
                  className="bg-input"
                  required
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="client-name">Client Name</Label>
                  <Input
                    id="client-name"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g., Acme Corp"
                    className="bg-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budget">Client Budget ($)</Label>
                  <Input
                    id="budget"
                    type="number"
                    min="0"
                    step="0.01"
                    value={clientBudget}
                    onChange={(e) => setClientBudget(e.target.value)}
                    placeholder="0.00"
                    className="bg-input"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="video-format">Video Format</Label>
                  <Input
                    id="video-format"
                    value={videoFormat}
                    onChange={(e) => setVideoFormat(e.target.value)}
                    placeholder="e.g., 16:9, Reels, YouTube"
                    className="bg-input"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-code">Project Code</Label>
                  <Input
                    id="project-code"
                    value={projectCode}
                    onChange={(e) => setProjectCode(e.target.value)}
                    placeholder="ABC123"
                    className="bg-input"
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional. Format: 3-4 letters + 3 numbers.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as ProjectStatus)}>
                  <SelectTrigger className="bg-input">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROJECT_STATUSES.map((projectStatus) => (
                      <SelectItem key={projectStatus.value} value={projectStatus.value}>
                        {projectStatus.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button type="button" variant="outline" onClick={() => navigate('/projects')}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} className="bg-primary hover:bg-primary/90">
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4 mr-2" />
                      Create Project
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
