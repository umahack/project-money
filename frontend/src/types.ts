// Shapes returned by the Project Money API. Money is in rupees (floating point), as the API stores it.

export interface User {
  id: number;
  name: string;
  email: string;
  is_admin: boolean;
}

export interface Emi {
  id: number;
  label: string;
  amount: number;
  category: string;
  created_at?: string;
}

export interface Plan {
  income: number;
  emiTotal: number;
  afterFixed: number;
  breakdown: { needs: number; wants: number; save: number };
  tips: string[];
  month?: string;
  spentThisMonth?: number;
  byCategory?: Record<string, number>;
}

export interface Trip {
  id: number;
  name: string;
  destination: string | null;
  budget: number;
  start_date: string | null;
  end_date: string | null;
}

export interface TripMember {
  id: number;
  name: string;
  email: string | null;
}

export interface TripExpense {
  id: number;
  payer: string;
  description: string;
  amount: number;
  created_at: string;
  split: Array<{ name: string; share: number }>;
}

export interface TripDetailData {
  trip: Trip;
  role?: 'owner' | 'member';
  members: TripMember[];
  expenses: TripExpense[];
  settlement: {
    balances: Record<string, number>;
    transactions: Array<{ from: string; to: string; amount: number }>;
  };
}

export interface Invite {
  id: number;
  trip_id: number;
  created_at: string;
  trip_name: string;
  destination: string | null;
  budget: number;
  inviter_name: string;
  inviter_email: string;
}

export interface AdminStats {
  users: number;
  admins: number;
  trips: number;
  emis: number;
  total_income: number;
  total_emi: number;
  feedback_count: number;
  avg_rating: number | null;
}

export interface AdminUserRow {
  id: number;
  email: string;
  name: string;
  is_admin: number;
  created_at: string;
  latest_salary: number | null;
  emi_total: number;
  trip_count: number;
}

export interface AdminUserDetail {
  user: { id: number; email: string; name: string; is_admin: number; created_at: string };
  salaries: Array<{ month: string; amount: number }>;
  emis: Emi[];
  trips: Trip[];
}

export interface FeedbackRow {
  id: number;
  user_id: number | null;
  email: string | null;
  rating: number;
  message: string | null;
  created_at: string;
}

// Versioned clarity contracts are re-exported here for compatibility while new
// clarity code imports them directly from ./clarity/contracts.
export type * from './clarity/contracts';