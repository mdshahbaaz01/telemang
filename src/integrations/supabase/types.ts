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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_group_members: {
        Row: {
          account_id: string
          created_at: string
          group_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          group_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          group_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_group_members_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "account_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      account_groups: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      action_logs: {
        Row: {
          account_id: string | null
          created_at: string
          id: number
          level: string
          message: string
          run_id: string
          target: string | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          id?: number
          level: string
          message: string
          run_id: string
          target?: string | null
        }
        Update: {
          account_id?: string | null
          created_at?: string
          id?: number
          level?: string
          message?: string
          run_id?: string
          target?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "action_logs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "action_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      action_runs: {
        Row: {
          created_at: string
          id: string
          kind: string
          params: Json
          status: string
          totals: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          params?: Json
          status?: string
          totals?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          params?: Json
          status?: string
          totals?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      bot_parse_results: {
        Row: {
          account_id: string
          bot_username: string
          captured_at: string
          field_name: string
          id: string
          raw_text: string | null
          rule_id: string | null
          user_id: string
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          account_id: string
          bot_username: string
          captured_at?: string
          field_name: string
          id?: string
          raw_text?: string | null
          rule_id?: string | null
          user_id: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          account_id?: string
          bot_username?: string
          captured_at?: string
          field_name?: string
          id?: string
          raw_text?: string | null
          rule_id?: string | null
          user_id?: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bot_parse_results_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "bot_parse_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_parse_rules: {
        Row: {
          bot_username: string
          created_at: string
          field_name: string
          id: string
          name: string
          regex: string
          unit: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bot_username: string
          created_at?: string
          field_name: string
          id?: string
          name: string
          regex: string
          unit?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bot_username?: string
          created_at?: string
          field_name?: string
          id?: string
          name?: string
          regex?: string
          unit?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      join_task_items: {
        Row: {
          error: string | null
          id: string
          leave_after: string | null
          left_at: string | null
          position: number
          processed_at: string | null
          status: string
          target: string
          task_id: string
          user_id: string
        }
        Insert: {
          error?: string | null
          id?: string
          leave_after?: string | null
          left_at?: string | null
          position?: number
          processed_at?: string | null
          status?: string
          target: string
          task_id: string
          user_id: string
        }
        Update: {
          error?: string | null
          id?: string
          leave_after?: string | null
          left_at?: string | null
          position?: number
          processed_at?: string | null
          status?: string
          target?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "join_task_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "join_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      join_tasks: {
        Row: {
          account_id: string
          auto_leave_after_days: number | null
          created_at: string
          group_id: string | null
          id: string
          max_delay: number
          min_delay: number
          name: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id: string
          auto_leave_after_days?: number | null
          created_at?: string
          group_id?: string | null
          id?: string
          max_delay?: number
          min_delay?: number
          name?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string
          auto_leave_after_days?: number | null
          created_at?: string
          group_id?: string | null
          id?: string
          max_delay?: number
          min_delay?: number
          name?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "join_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          api_hash_enc: string
          api_id: number
          created_at: string
          id: string
          phone: string
          phone_code_hash: string | null
          session_enc: string | null
          stage: string
          user_id: string
        }
        Insert: {
          api_hash_enc: string
          api_id: number
          created_at?: string
          id?: string
          phone: string
          phone_code_hash?: string | null
          session_enc?: string | null
          stage?: string
          user_id: string
        }
        Update: {
          api_hash_enc?: string
          api_id?: number
          created_at?: string
          id?: string
          phone?: string
          phone_code_hash?: string | null
          session_enc?: string | null
          stage?: string
          user_id?: string
        }
        Relationships: []
      }
      message_templates: {
        Row: {
          attachments: Json
          body: string
          created_at: string
          format: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attachments?: Json
          body?: string
          created_at?: string
          format?: string
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attachments?: Json
          body?: string
          created_at?: string
          format?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_logs: {
        Row: {
          body: string
          channel: string
          created_at: string
          error: string | null
          event: string
          id: string
          status: string
          title: string
          user_id: string
        }
        Insert: {
          body: string
          channel: string
          created_at?: string
          error?: string | null
          event: string
          id?: string
          status?: string
          title: string
          user_id: string
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string
          error?: string | null
          event?: string
          id?: string
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      notification_settings: {
        Row: {
          alert_account: boolean
          alert_failure: boolean
          alert_on_ban: boolean
          alert_on_job_failure: boolean
          alert_on_peer_flood: boolean
          alert_success: boolean
          created_at: string
          daily_summary_ist_time: string | null
          daily_summary_last_sent_date: string | null
          email_enabled: boolean
          email_to: string | null
          telegram_chat: string | null
          telegram_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          alert_account?: boolean
          alert_failure?: boolean
          alert_on_ban?: boolean
          alert_on_job_failure?: boolean
          alert_on_peer_flood?: boolean
          alert_success?: boolean
          created_at?: string
          daily_summary_ist_time?: string | null
          daily_summary_last_sent_date?: string | null
          email_enabled?: boolean
          email_to?: string | null
          telegram_chat?: string | null
          telegram_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          alert_account?: boolean
          alert_failure?: boolean
          alert_on_ban?: boolean
          alert_on_job_failure?: boolean
          alert_on_peer_flood?: boolean
          alert_success?: boolean
          created_at?: string
          daily_summary_ist_time?: string | null
          daily_summary_last_sent_date?: string | null
          email_enabled?: boolean
          email_to?: string | null
          telegram_chat?: string | null
          telegram_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      referral_joins: {
        Row: {
          account_id: string
          created_at: string
          id: string
          joined_at: string | null
          last_balance_numeric: number | null
          last_balance_text: string | null
          last_checked_at: string | null
          last_error: string | null
          referral_link_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          joined_at?: string | null
          last_balance_numeric?: number | null
          last_balance_text?: string | null
          last_checked_at?: string | null
          last_error?: string | null
          referral_link_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          joined_at?: string | null
          last_balance_numeric?: number | null
          last_balance_text?: string | null
          last_checked_at?: string | null
          last_error?: string | null
          referral_link_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_joins_referral_link_id_fkey"
            columns: ["referral_link_id"]
            isOneToOne: false
            referencedRelation: "referral_links"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_links: {
        Row: {
          balance_field: string | null
          base_link: string
          bot_username: string
          created_at: string
          id: string
          my_ref_code: string | null
          note: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          balance_field?: string | null
          base_link: string
          bot_username: string
          created_at?: string
          id?: string
          my_ref_code?: string | null
          note?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          balance_field?: string | null
          base_link?: string
          bot_username?: string
          created_at?: string
          id?: string
          my_ref_code?: string | null
          note?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scheduled_broadcast_items: {
        Row: {
          account_id: string
          attempt_count: number
          created_at: string
          error: string | null
          id: string
          kind: string
          locked_at: string | null
          payload: Json
          processed_at: string | null
          schedule_id: string
          scheduled_for: string
          status: string
          target: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id: string
          attempt_count?: number
          created_at?: string
          error?: string | null
          id?: string
          kind: string
          locked_at?: string | null
          payload?: Json
          processed_at?: string | null
          schedule_id: string
          scheduled_for: string
          status?: string
          target?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string
          attempt_count?: number
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          locked_at?: string | null
          payload?: Json
          processed_at?: string | null
          schedule_id?: string
          scheduled_for?: string
          status?: string
          target?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_broadcast_items_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "scheduled_broadcasts"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_broadcasts: {
        Row: {
          completed_at: string | null
          created_at: string
          dispatched_at: string | null
          error: string | null
          id: string
          label: string | null
          payload: Json
          processed_items: number
          run_id: string | null
          scheduled_at: string
          status: string
          total_items: number
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          dispatched_at?: string | null
          error?: string | null
          id?: string
          label?: string | null
          payload: Json
          processed_items?: number
          run_id?: string | null
          scheduled_at: string
          status?: string
          total_items?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          dispatched_at?: string | null
          error?: string | null
          id?: string
          label?: string | null
          payload?: Json
          processed_items?: number
          run_id?: string | null
          scheduled_at?: string
          status?: string
          total_items?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      task_logs: {
        Row: {
          created_at: string
          id: string
          level: string
          message: string
          task_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          level?: string
          message: string
          task_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          level?: string
          message?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_logs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "join_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_accounts: {
        Row: {
          api_hash_enc: string
          api_id: number
          created_at: string
          first_name: string | null
          id: string
          last_error: string | null
          last_name: string | null
          paused_until: string | null
          phone: string
          session_enc: string | null
          signature: string | null
          status: string
          telegram_user_id: number | null
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          api_hash_enc: string
          api_id: number
          created_at?: string
          first_name?: string | null
          id?: string
          last_error?: string | null
          last_name?: string | null
          paused_until?: string | null
          phone: string
          session_enc?: string | null
          signature?: string | null
          status?: string
          telegram_user_id?: number | null
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          api_hash_enc?: string
          api_id?: number
          created_at?: string
          first_name?: string | null
          id?: string
          last_error?: string | null
          last_name?: string | null
          paused_until?: string | null
          phone?: string
          session_enc?: string | null
          signature?: string | null
          status?: string
          telegram_user_id?: number | null
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
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
      is_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "user"
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
      app_role: ["admin", "user"],
    },
  },
} as const
