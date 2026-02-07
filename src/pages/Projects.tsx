import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Project, PROJECT_STATUSES, ProjectStatus } from '@/lib/types';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScopeSentinelModal } from '@/components/projects/ScopeSentinelModal';
import { SyncStatusIndicator } from '@/components/settings/SyncStatusIndicator';
import { VideoUploadModal } from '@/components/video-upload/VideoUploadModal';
import { useNotionPush } from '@/hooks/useNotionPush';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  Search,
  Filter,
  Plus,
  ChevronRight,
  Brain,
  DollarSign,
  GitBranch,
  Upload,
  ExternalLink,
  Video,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface AIPrediction {
  recommendation: 'our_fault' | 'client_scope';
  confidence: number;
  reasoning: string;
  dataPoints: string[];
}

export default function Projects() {
  const { isAdmin, isProducer } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [filteredProjects, setFilteredProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  
  // Scope Sentinel state
  const [sentinelOpen, setSentinelOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [aiPrediction, setAiPrediction] = useState<AIPrediction | null>(null);
  const [isLoadingPrediction, setIsLoadingPrediction] = useState(false);
  
  // Video Upload state
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadProject, setUploadProject] = useState<Project | null>(null);
  
  const navigate = useNavigate();
  const { toast } = useToast();
  const { pushProjectUpdate } = useNotionPush();

  const fetchProjects = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false });

      if (error) throw error;
      setProjects((data || []) as unknown as Project[]);
    } catch (error) {
      console.error('Error fetching projects:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load projects',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    let result = projects;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(query) ||
          p.client_name?.toLowerCase().includes(query)
      );
    }

    if (statusFilter !== 'all') {
      result = result.filter((p) => p.status === statusFilter);
    }

    setFilteredProjects(result);
  }, [projects, searchQuery, statusFilter]);

  const handleStatusChange = async (project: Project, newStatus: string) => {
    // Trigger Scope Sentinel for revision-related status changes
    if (newStatus === 'ready_for_edit' || newStatus === 'in_revision') {
      setSelectedProject(project);
      setSentinelOpen(true);
      setIsLoadingPrediction(true);

      // Fetch AI prediction
      try {
        const { data, error } = await supabase.functions.invoke('analyze-revision', {
          body: {
            projectId: project.id,
            projectTitle: project.title,
            clientName: project.client_name,
            revisionHistory: {
              billable: project.billable_revisions,
              internal: project.internal_revisions,
            },
            currentStatus: project.status,
          },
        });

        if (error) throw error;
        setAiPrediction(data);
      } catch (error) {
        console.error('Error fetching AI prediction:', error);
        // Continue without prediction
      } finally {
        setIsLoadingPrediction(false);
      }
      return;
    }

    // Direct status update for other changes
    await updateProjectStatus(project.id, newStatus);
  };

  const updateProjectStatus = async (projectId: string, newStatus: string) => {
    // Find the project to get its notion_id
    const project = projects.find(p => p.id === projectId);
    
    try {
      const { error } = await supabase
        .from('projects')
        .update({ status: newStatus })
        .eq('id', projectId);

      if (error) throw error;

      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, status: newStatus } : p))
      );

      // Auto-push to Notion if project has a notion_id
      if (project?.notion_id) {
        pushProjectUpdate(project.notion_id, { status: newStatus });
      }

      toast({
        title: 'Status updated',
        description: `Project moved to ${newStatus.replace(/_/g, ' ')}`,
      });
    } catch (error) {
      console.error('Error updating status:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update project status',
      });
    }
  };

  const handleRevisionDecision = async (isOurFault: boolean) => {
    if (!selectedProject) return;

    try {
      const updateData = isOurFault
        ? { internal_revisions: selectedProject.internal_revisions + 1 }
        : { billable_revisions: selectedProject.billable_revisions + 1 };

      const { error } = await supabase
        .from('projects')
        .update({
          ...updateData,
          status: 'in_revision',
          ai_thought_trace: aiPrediction
            ? {
                reasoning: aiPrediction.reasoning,
                data_sources: aiPrediction.dataPoints,
                confidence: aiPrediction.confidence,
                timestamp: new Date().toISOString(),
              }
            : null,
        })
        .eq('id', selectedProject.id);

      if (error) throw error;

      // Log the decision
      await supabase.from('system_logs').insert({
        action_type: 'scope_sentinel_decision',
        user_action: isOurFault ? 'marked_our_fault' : 'marked_client_scope',
        related_project_id: selectedProject.id,
        thought_trace: aiPrediction
          ? {
              reasoning: aiPrediction.reasoning,
              data_sources: aiPrediction.dataPoints,
              confidence: aiPrediction.confidence,
              timestamp: new Date().toISOString(),
            }
          : null,
        metadata: {
          project_title: selectedProject.title,
          decision: isOurFault ? 'our_fault' : 'client_scope',
          ai_recommendation: aiPrediction?.recommendation,
        },
      });

      await fetchProjects();

      toast({
        title: 'Revision recorded',
        description: isOurFault
          ? 'Marked as internal revision (not billable)'
          : 'Marked as client scope change (billable)',
      });
    } catch (error) {
      console.error('Error recording revision:', error);
      throw error;
    } finally {
      setSelectedProject(null);
      setAiPrediction(null);
    }
  };

  const handleUploadComplete = async (projectId: string, frameioLink: string) => {
    // Update local state
    setProjects(prev => 
      prev.map(p => p.id === projectId ? { ...p, frameio_link: frameioLink } : p)
    );
    setUploadModalOpen(false);
    setUploadProject(null);
  };

  const openUploadModal = (project: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setUploadProject(project);
    setUploadModalOpen(true);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
      case 'in_progress':
        return 'status-active';
      case 'ready_for_edit':
      case 'in_revision':
        return 'status-pending';
      case 'completed':
        return 'bg-muted text-muted-foreground';
      case 'on_hold':
        return 'status-error';
      default:
        return 'bg-secondary text-secondary-foreground';
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 animate-in">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Projects</h1>
            <p className="text-muted-foreground mt-1">
              Manage your video production projects
            </p>
          </div>
          <div className="flex items-center gap-3">
            <SyncStatusIndicator compact onSyncComplete={fetchProjects} />
            {(isAdmin || isProducer) && (
              <Button className="bg-primary hover:bg-primary/90">
                <Plus className="h-4 w-4 mr-2" />
                New Project
              </Button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-input border-border"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-48 bg-input border-border">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {PROJECT_STATUSES.map((status) => (
                <SelectItem key={status.value} value={status.value}>
                  {status.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Projects Grid */}
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} className="glass-card">
                <CardContent className="p-6">
                  <div className="skeleton h-6 w-3/4 mb-4" />
                  <div className="skeleton h-4 w-1/2 mb-2" />
                  <div className="skeleton h-4 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <Card className="glass-card">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No projects found</p>
              {(isAdmin || isProducer) && (
                <Button variant="link" className="mt-2">
                  Create your first project
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => (
              <Card
                key={project.id}
                className="glass-card hover-lift cursor-pointer group"
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-lg line-clamp-1">
                      {project.title}
                    </CardTitle>
                    <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {project.client_name || 'No client'}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Status & Actions */}
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        'text-xs px-2.5 py-1 rounded-full',
                        getStatusColor(project.status)
                      )}
                    >
                      {project.status.replace(/_/g, ' ')}
                    </span>

                    {(isAdmin || isProducer) && (
                      <Select
                        value={project.status}
                        onValueChange={(value) => {
                          // Prevent navigation when clicking dropdown
                          handleStatusChange(project, value);
                        }}
                      >
                        <SelectTrigger
                          className="w-auto h-8 text-xs bg-secondary border-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent onClick={(e) => e.stopPropagation()}>
                          {PROJECT_STATUSES.map((status) => (
                            <SelectItem key={status.value} value={status.value}>
                              {status.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <DollarSign className="h-4 w-4" />
                      <span>
                        ${Number(project.client_budget || 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <GitBranch className="h-4 w-4" />
                      <span>
                        {project.billable_revisions + project.internal_revisions} rev
                      </span>
                    </div>
                    {project.ai_thought_trace && (
                      <div className="flex items-center gap-1.5 text-primary">
                        <Brain className="h-4 w-4" />
                        <span className="text-xs">AI</span>
                      </div>
                    )}
                  </div>

                  {/* Frame.io Link & Upload */}
                  <div className="flex items-center gap-2 pt-2 border-t border-border">
                    {(project as any).frameio_link ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open((project as any).frameio_link, '_blank');
                        }}
                      >
                        <Video className="h-3 w-3 mr-1" />
                        View on Frame.io
                        <ExternalLink className="h-3 w-3 ml-1" />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 text-xs"
                        onClick={(e) => openUploadModal(project, e)}
                      >
                        <Upload className="h-3 w-3 mr-1" />
                        Upload Video
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Scope Sentinel Modal */}
      {selectedProject && (
        <ScopeSentinelModal
          open={sentinelOpen}
          onOpenChange={setSentinelOpen}
          projectTitle={selectedProject.title}
          projectId={selectedProject.id}
          aiPrediction={aiPrediction}
          isLoadingPrediction={isLoadingPrediction}
          onDecision={handleRevisionDecision}
        />
      )}

      {/* Video Upload Modal */}
      {uploadProject && (
        <VideoUploadModal
          open={uploadModalOpen}
          onOpenChange={setUploadModalOpen}
          projectId={uploadProject.id}
          projectTitle={uploadProject.title}
          clientName={uploadProject.client_name}
          onComplete={(link) => handleUploadComplete(uploadProject.id, link)}
        />
      )}
    </AppLayout>
  );
}
