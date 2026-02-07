import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Project, WorkLog } from '@/lib/types';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  FolderKanban, 
  Clock, 
  TrendingUp, 
  AlertCircle,
  Plus,
  ArrowRight
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const { profile, role, isAdmin, isProducer } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [recentLogs, setRecentLogs] = useState<WorkLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch projects
      const { data: projectsData, error: projectsError } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(5);

      if (projectsError) throw projectsError;
      setProjects((projectsData || []) as unknown as Project[]);

      // Fetch recent work logs
      const { data: logsData, error: logsError } = await supabase
        .from('work_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

      if (logsError) throw logsError;
      setRecentLogs((logsData || []) as unknown as WorkLog[]);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const activeProjects = projects.filter(p => p.status !== 'completed').length;
  const totalRevisions = projects.reduce((sum, p) => sum + p.billable_revisions + p.internal_revisions, 0);
  const totalHours = recentLogs.reduce((sum, l) => sum + Number(l.hours), 0);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
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
        return 'bg-muted text-muted-foreground border border-border';
      default:
        return 'bg-secondary text-secondary-foreground';
    }
  };

  return (
    <AppLayout>
      <div className="space-y-8 animate-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">
              {getGreeting()}, {profile?.full_name?.split(' ')[0] || 'there'}
            </h1>
            <p className="text-muted-foreground mt-1">
              Here's what's happening in your studio today
            </p>
          </div>
          {(isAdmin || isProducer) && (
            <Button 
              onClick={() => navigate('/projects/new')}
              className="bg-primary hover:bg-primary/90"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          )}
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="glass-card hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Active Projects
              </CardTitle>
              <FolderKanban className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{activeProjects}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {projects.length} total projects
              </p>
            </CardContent>
          </Card>

          <Card className="glass-card hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Hours This Week
              </CardTitle>
              <Clock className="h-4 w-4 text-info" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{totalHours.toFixed(1)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Across {recentLogs.length} sessions
              </p>
            </CardContent>
          </Card>

          <Card className="glass-card hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Revisions
              </CardTitle>
              <TrendingUp className="h-4 w-4 text-warning" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{totalRevisions}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Billable & internal
              </p>
            </CardContent>
          </Card>

          <Card className="glass-card hover-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Pending Actions
              </CardTitle>
              <AlertCircle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {projects.filter(p => p.status === 'in_revision').length}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Awaiting revision decisions
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Projects List */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="glass-card">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Recent Projects</CardTitle>
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => navigate('/projects')}
                className="text-muted-foreground hover:text-foreground"
              >
                View all
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-16 rounded-lg" />
                  ))}
                </div>
              ) : projects.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FolderKanban className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No projects yet</p>
                  {(isAdmin || isProducer) && (
                    <Button
                      variant="link"
                      onClick={() => navigate('/projects/new')}
                      className="mt-2"
                    >
                      Create your first project
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      onClick={() => navigate(`/projects/${project.id}`)}
                      className="w-full flex items-center justify-between p-4 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors text-left"
                    >
                      <div>
                        <h4 className="font-medium">{project.title}</h4>
                        <p className="text-sm text-muted-foreground">
                          {project.client_name || 'No client'}
                        </p>
                      </div>
                      <span className={`text-xs px-2.5 py-1 rounded-full ${getStatusColor(project.status)}`}>
                        {project.status.replace(/_/g, ' ')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="secondary"
                className="w-full justify-start h-auto py-4"
                onClick={() => navigate('/time-logger')}
              >
                <Clock className="h-5 w-5 mr-3 text-info" />
                <div className="text-left">
                  <div className="font-medium">Log Time</div>
                  <div className="text-sm text-muted-foreground">
                    Track hours on your current project
                  </div>
                </div>
              </Button>

              <Button
                variant="secondary"
                className="w-full justify-start h-auto py-4"
                onClick={() => navigate('/projects')}
              >
                <FolderKanban className="h-5 w-5 mr-3 text-primary" />
                <div className="text-left">
                  <div className="font-medium">View Projects</div>
                  <div className="text-sm text-muted-foreground">
                    Browse and manage all projects
                  </div>
                </div>
              </Button>

              {isAdmin && (
                <Button
                  variant="secondary"
                  className="w-full justify-start h-auto py-4"
                  onClick={() => navigate('/settings')}
                >
                  <AlertCircle className="h-5 w-5 mr-3 text-warning" />
                  <div className="text-left">
                    <div className="font-medium">Admin Settings</div>
                    <div className="text-sm text-muted-foreground">
                      Configure Notion sync & team roles
                    </div>
                  </div>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
