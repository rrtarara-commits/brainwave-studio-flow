export type AppRole = 'admin' | 'producer' | 'editor';

export interface UserProfile {
  id: string;
  user_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  hourly_rate: number;
  friction_score: number;
  can_manage_resources: boolean;
  can_upload_footage: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserRole {
  id: string;
  user_id: string;
  role: AppRole;
}

export interface Project {
  id: string;
  notion_id: string | null;
  title: string;
  status: string;
  client_name: string | null;
  client_budget: number;
  billable_revisions: number;
  internal_revisions: number;
  sentiment_score: number;
  ai_thought_trace: AIThoughtTrace | null;
  video_format: string | null;
  assigned_editor_id: string | null;
  assigned_producer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkLog {
  id: string;
  project_id: string;
  user_id: string;
  hours: number;
  task_type: string[];
  notes: string | null;
  is_disputed: boolean;
  dispute_reason: string | null;
  logged_at: string;
  created_at: string;
}

export interface Expense {
  id: string;
  project_id: string;
  user_id: string;
  description: string;
  amount: number;
  receipt_url: string | null;
  receipt_skipped: boolean;
  created_at: string;
}

export interface CrewFeedback {
  id: string;
  target_user_id: string;
  author_id: string;
  project_id: string | null;
  rating: number | null;
  turnaround_days: number | null;
  technical_error_rate: number | null;
  private_notes: string | null;
  created_at: string;
}

export interface SystemLog {
  id: string;
  timestamp: string;
  user_id: string | null;
  action_type: string;
  user_action: string | null;
  ai_prompt: string | null;
  ai_response: string | null;
  thought_trace: AIThoughtTrace | null;
  related_project_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AppConfig {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface AIThoughtTrace {
  reasoning: string;
  data_sources: string[];
  confidence: number;
  keywords_matched?: string[];
  timestamp: string;
}

export interface RevisionDecision {
  isOurFault: boolean;
  aiPrediction?: {
    recommendation: 'our_fault' | 'client_scope';
    confidence: number;
    reasoning: string;
  };
}

export interface CrewFitCheck {
  userId: string;
  historicalFrictionScore: number;
  avgTurnaroundDays: number;
  technicalErrorRate: number;
  projectsCompleted: number;
}

export type ProjectStatus = 
  | 'active'
  | 'in_progress'
  | 'ready_for_edit'
  | 'in_revision'
  | 'completed'
  | 'on_hold';

export const PROJECT_STATUSES: { value: ProjectStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'ready_for_edit', label: 'Ready for Edit' },
  { value: 'in_revision', label: 'In Revision' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
];

export const TASK_TYPES = [
  'Editing',
  'Color Grading',
  'Audio Mixing',
  'Motion Graphics',
  'Meeting',
  'Review',
  'Export',
] as const;

export type TaskType = typeof TASK_TYPES[number];
