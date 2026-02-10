import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Project, WorkLog, Expense, TASK_TYPES, TaskType } from '@/lib/types';
import { workLogSchema, expenseSchema } from '@/lib/validation';
import { z } from 'zod';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Clock, Receipt, AlertTriangle, Plus, Loader2 } from 'lucide-react';

export default function TimeLogger() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Time entry form
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [hours, setHours] = useState('');
  const [selectedTasks, setSelectedTasks] = useState<TaskType[]>([]);
  const [notes, setNotes] = useState('');

  // Expense form
  const [expenseProject, setExpenseProject] = useState<string>('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [skipReceipt, setSkipReceipt] = useState(false);

  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      // Fetch projects
      const { data: projectsData } = await supabase
        .from('projects')
        .select('*')
        .order('title');
      setProjects((projectsData || []) as unknown as Project[]);

      // Fetch user's work logs
      const { data: logsData } = await supabase
        .from('work_logs')
        .select('*')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(20);
      setWorkLogs((logsData || []) as unknown as WorkLog[]);

      // Fetch user's expenses
      const { data: expensesData } = await supabase
        .from('expenses')
        .select('*')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(20);
      setExpenses((expensesData || []) as unknown as Expense[]);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleTimeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Parse hours safely
      const parsedHours = parseFloat(hours);
      
      // Validate with Zod schema
      const validated = workLogSchema.parse({
        project_id: selectedProject,
        hours: isNaN(parsedHours) ? undefined : parsedHours,
        task_type: selectedTasks,
        notes: notes || null,
      });

      setIsSubmitting(true);

      const { error } = await supabase.from('work_logs').insert({
        project_id: validated.project_id,
        hours: validated.hours,
        task_type: validated.task_type,
        notes: validated.notes ?? null,
        user_id: user?.id ?? '',
      });

      if (error) throw error;

      toast({
        title: 'Time logged',
        description: `${validated.hours} hours recorded successfully`,
      });

      // Reset form
      setHours('');
      setSelectedTasks([]);
      setNotes('');
      fetchData();
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast({
          variant: 'destructive',
          title: 'Validation Error',
          description: error.errors[0].message,
        });
        return;
      }
      console.error('Error logging time:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to log time',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Parse amount safely
      const parsedAmount = parseFloat(expenseAmount);
      
      // Validate with Zod schema
      const validated = expenseSchema.parse({
        project_id: expenseProject,
        description: expenseDescription,
        amount: isNaN(parsedAmount) ? undefined : parsedAmount,
        receipt_skipped: skipReceipt,
      });

      setIsSubmitting(true);

      const { error } = await supabase.from('expenses').insert({
        project_id: validated.project_id,
        description: validated.description,
        amount: validated.amount,
        receipt_skipped: validated.receipt_skipped,
        user_id: user?.id ?? '',
      });

      if (error) throw error;

      toast({
        title: 'Expense logged',
        description: `$${validated.amount.toFixed(2)} recorded successfully`,
      });

      // Reset form
      setExpenseDescription('');
      setExpenseAmount('');
      setSkipReceipt(false);
      fetchData();
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast({
          variant: 'destructive',
          title: 'Validation Error',
          description: error.errors[0].message,
        });
        return;
      }
      console.error('Error logging expense:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to log expense',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDispute = (log: WorkLog) => {
    const project = projects.find((p) => p.id === log.project_id);
    const subject = encodeURIComponent(`Time Log Dispute - ${project?.title || 'Unknown Project'}`);
    const body = encodeURIComponent(
      `Project: ${project?.title || 'Unknown'}\n` +
        `Log ID: ${log.id}\n` +
        `Hours: ${log.hours}\n` +
        `Tasks: ${log.task_type.join(', ')}\n` +
        `Date: ${new Date(log.logged_at).toLocaleDateString()}\n\n` +
        `Reason for dispute:\n`
    );
    window.location.href = `mailto:hello@tcv.studio?subject=${subject}&body=${body}`;
  };

  const toggleTask = (task: TaskType) => {
    setSelectedTasks((prev) =>
      prev.includes(task) ? prev.filter((t) => t !== task) : [...prev, task]
    );
  };

  const totalHours = workLogs.reduce((sum, log) => sum + Number(log.hours), 0);
  const totalExpenses = expenses.reduce((sum, exp) => sum + Number(exp.amount), 0);

  return (
    <AppLayout>
      <div className="space-y-6 animate-in">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Time & Expense Logger</h1>
          <p className="text-muted-foreground mt-1">
            Track your hours and project expenses
          </p>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="glass-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Hours (Recent)
              </CardTitle>
              <Clock className="h-4 w-4 text-info" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{totalHours.toFixed(1)}</div>
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Expenses (Recent)
              </CardTitle>
              <Receipt className="h-4 w-4 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">${totalExpenses.toFixed(2)}</div>
            </CardContent>
          </Card>
        </div>

        {/* Entry Forms */}
        <Tabs defaultValue="time" className="space-y-4">
          <TabsList className="bg-secondary">
            <TabsTrigger value="time" className="data-[state=active]:bg-background">
              <Clock className="h-4 w-4 mr-2" />
              Log Time
            </TabsTrigger>
            <TabsTrigger value="expense" className="data-[state=active]:bg-background">
              <Receipt className="h-4 w-4 mr-2" />
              Log Expense
            </TabsTrigger>
          </TabsList>

          {/* Time Entry Tab */}
          <TabsContent value="time">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle>New Time Entry</CardTitle>
                <CardDescription>
                  Log only the net new hours spent since your last save
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleTimeSubmit} className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Project</Label>
                      <Select
                        value={selectedProject}
                        onValueChange={setSelectedProject}
                      >
                        <SelectTrigger className="bg-input border-border">
                          <SelectValue placeholder="Select project" />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Hours (Net New)</Label>
                      <Input
                        type="number"
                        step="0.25"
                        min="0.25"
                        placeholder="e.g., 2.5"
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        className="bg-input border-border"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Task Tags</Label>
                    <div className="flex flex-wrap gap-2">
                      {TASK_TYPES.map((task) => (
                        <Button
                          key={task}
                          type="button"
                          variant={selectedTasks.includes(task) ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => toggleTask(task)}
                          className={
                            selectedTasks.includes(task)
                              ? 'bg-primary text-primary-foreground'
                              : ''
                          }
                        >
                          {task}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Notes (optional)</Label>
                    <Textarea
                      placeholder="What did you work on?"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="bg-input border-border min-h-[80px]"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-primary hover:bg-primary/90"
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Plus className="h-4 w-4 mr-2" />
                    )}
                    Log Time
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Expense Tab */}
          <TabsContent value="expense">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle>Quick Expense Log</CardTitle>
                <CardDescription>
                  Log expenses with optional receipt upload
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleExpenseSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Project</Label>
                    <Select
                      value={expenseProject}
                      onValueChange={setExpenseProject}
                    >
                      <SelectTrigger className="bg-input border-border">
                        <SelectValue placeholder="Select project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Input
                        placeholder="e.g., Stock footage license"
                        value={expenseDescription}
                        onChange={(e) => setExpenseDescription(e.target.value)}
                        className="bg-input border-border"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Amount ($)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        placeholder="0.00"
                        value={expenseAmount}
                        onChange={(e) => setExpenseAmount(e.target.value)}
                        className="bg-input border-border"
                      />
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="skipReceipt"
                      checked={skipReceipt}
                      onCheckedChange={(checked) => setSkipReceipt(checked as boolean)}
                    />
                    <label
                      htmlFor="skipReceipt"
                      className="text-sm text-muted-foreground cursor-pointer"
                    >
                      Skip receipt for now
                    </label>
                  </div>

                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="bg-primary hover:bg-primary/90"
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Plus className="h-4 w-4 mr-2" />
                    )}
                    Log Expense
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Recent Logs */}
        <Card className="glass-card">
          <CardHeader>
            <CardTitle>Recent Time Logs</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-16 rounded-lg" />
                ))}
              </div>
            ) : workLogs.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No time logs yet
              </p>
            ) : (
              <div className="space-y-3">
                {workLogs.map((log) => {
                  const project = projects.find((p) => p.id === log.project_id);
                  return (
                    <div
                      key={log.id}
                      className="flex items-center justify-between p-4 rounded-lg bg-secondary/50"
                    >
                      <div>
                        <p className="font-medium">
                          {project?.title || 'Unknown Project'}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-sm text-muted-foreground">
                            {Number(log.hours).toFixed(1)}h
                          </span>
                          <span className="text-muted-foreground">•</span>
                          <span className="text-sm text-muted-foreground">
                            {log.task_type.join(', ')}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {new Date(log.logged_at).toLocaleDateString()}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDispute(log)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <AlertTriangle className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
