export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          updated_by: string | null
          value: string
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          value: string
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
      crew_feedback: {
        Row: {
          author_id: string
          created_at: string
          id: string
          private_notes: string | null
          project_id: string | null
          rating: number | null
          target_user_id: string
          technical_error_rate: number | null
          turnaround_days: number | null
        }
        Insert: {
          author_id: string
          created_at?: string
          id?: string
          private_notes?: string | null
          project_id?: string | null
          rating?: number | null
          target_user_id: string
          technical_error_rate?: number | null
          turnaround_days?: number | null
        }
        Update: {
          author_id?: string
          created_at?: string
          id?: string
          private_notes?: string | null
          project_id?: string | null
          rating?: number | null
          target_user_id?: string
          technical_error_rate?: number | null
          turnaround_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "crew_feedback_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crew_feedback_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          created_at: string
          description: string
          id: string
          project_id: string
          receipt_skipped: boolean | null
          receipt_url: string | null
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          description: string
          id?: string
          project_id: string
          receipt_skipped?: boolean | null
          receipt_url?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string
          id?: string
          project_id?: string
          receipt_skipped?: boolean | null
          receipt_url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          can_manage_resources: boolean | null
          can_upload_footage: boolean | null
          created_at: string
          email: string | null
          friction_score: number | null
          full_name: string | null
          hourly_rate: number | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          can_manage_resources?: boolean | null
          can_upload_footage?: boolean | null
          created_at?: string
          email?: string | null
          friction_score?: number | null
          full_name?: string | null
          hourly_rate?: number | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          can_manage_resources?: boolean | null
          can_upload_footage?: boolean | null
          created_at?: string
          email?: string | null
          friction_score?: number | null
          full_name?: string | null
          hourly_rate?: number | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          ai_thought_trace: Json | null
          assigned_editor_id: string | null
          assigned_producer_id: string | null
          billable_revisions: number | null
          client_budget: number | null
          client_name: string | null
          created_at: string
          id: string
          internal_revisions: number | null
          notion_id: string | null
          sentiment_score: number | null
          status: string
          title: string
          updated_at: string
          video_format: string | null
        }
        Insert: {
          ai_thought_trace?: Json | null
          assigned_editor_id?: string | null
          assigned_producer_id?: string | null
          billable_revisions?: number | null
          client_budget?: number | null
          client_name?: string | null
          created_at?: string
          id?: string
          internal_revisions?: number | null
          notion_id?: string | null
          sentiment_score?: number | null
          status?: string
          title: string
          updated_at?: string
          video_format?: string | null
        }
        Update: {
          ai_thought_trace?: Json | null
          assigned_editor_id?: string | null
          assigned_producer_id?: string | null
          billable_revisions?: number | null
          client_budget?: number | null
          client_name?: string | null
          created_at?: string
          id?: string
          internal_revisions?: number | null
          notion_id?: string | null
          sentiment_score?: number | null
          status?: string
          title?: string
          updated_at?: string
          video_format?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_assigned_editor_id_fkey"
            columns: ["assigned_editor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_assigned_producer_id_fkey"
            columns: ["assigned_producer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      system_logs: {
        Row: {
          action_type: string
          ai_prompt: string | null
          ai_response: string | null
          id: string
          metadata: Json | null
          related_project_id: string | null
          thought_trace: Json | null
          timestamp: string
          user_action: string | null
          user_id: string | null
        }
        Insert: {
          action_type: string
          ai_prompt?: string | null
          ai_response?: string | null
          id?: string
          metadata?: Json | null
          related_project_id?: string | null
          thought_trace?: Json | null
          timestamp?: string
          user_action?: string | null
          user_id?: string | null
        }
        Update: {
          action_type?: string
          ai_prompt?: string | null
          ai_response?: string | null
          id?: string
          metadata?: Json | null
          related_project_id?: string | null
          thought_trace?: Json | null
          timestamp?: string
          user_action?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_logs_related_project_id_fkey"
            columns: ["related_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      work_logs: {
        Row: {
          created_at: string
          dispute_reason: string | null
          hours: number
          id: string
          is_disputed: boolean | null
          logged_at: string
          notes: string | null
          project_id: string
          task_type: string[]
          user_id: string
        }
        Insert: {
          created_at?: string
          dispute_reason?: string | null
          hours: number
          id?: string
          is_disputed?: boolean | null
          logged_at?: string
          notes?: string | null
          project_id: string
          task_type?: string[]
          user_id: string
        }
        Update: {
          created_at?: string
          dispute_reason?: string | null
          hours?: number
          id?: string
          is_disputed?: boolean | null
          logged_at?: string
          notes?: string | null
          project_id?: string
          task_type?: string[]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "producer" | "editor"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "producer", "editor"],
    },
  },
} as const
