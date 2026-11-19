import { inr } from './money';
import type { Emi, Plan } from './types';

export type Level = 'success' | 'info' | 'warn' | 'danger';
export interface Rec {
  level: Level;
  title: string;
  text: string;
}
export type Health = 'empty' | 'excellent' | 'good' | 'tight' | 'critical';

export interface Insights {
  health: Health;
  emiRatio: number;
  dailyAllowance: number;        // flat: (needs+wants) / daysInMonth
  dailyLeft: number;             // dynamic: (needs+wants - spent) / daysRemaining
  daysRemaining: number;
  emergencyTarget: number;
  spentOnNeeds: number;          // sum of expense_log in Needs categories
  spentOnWants: number;          // total - spentOnNeeds
  actualSave: number;            // income - emiTotal - total spent (floored at 0)
  overspentNeeds: number;        // max(0, spent - budget)
  overspentWants: number;
  recs: Rec[];
}

export interface Projection {
  monthlySave: number;           // 20% target save at this income
  fiveYear: number;              // compounded 5y @ 8% apr
  fiveYearIfCutWants20: number;  // + save an extra 20% of wants budget
  wantsBudget: number;           // for display
}

/** Future value of a monthly SIP compounded monthly at `apr` annual. */
function futureValueMonthlySIP(monthly: number, years: number, apr: number): number {
  const r = apr / 12;
  const n = years * 12;
  if (monthly <= 0 || r === 0) return monthly * n;
  return monthly * ((Math.pow(1 + r, n) - 1) / r);
}

/**
 * Killer-number math: what the user's plan compounds to in 5 years,
 * and what cutting their wants by 20% unlocks on top. Returns zeros
 * when income is absent so callers can render a placeholder.
 */
export function buildProjection(plan: Plan): Projection {
  const monthlySave = plan.breakdown.save;
  const wantsBudget = plan.breakdown.wants;
  const extra = Math.round(wantsBudget * 0.2);
  return {
    monthlySave,
    wantsBudget,
    fiveYear: Math.round(futureValueMonthlySIP(monthlySave, 5, 0.08)),
    fiveYearIfCutWants20: Math.round(futureValueMonthlySIP(monthlySave + extra, 5, 0.08)),
  };
}

const daysThisMonth = (): number => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};
const daysRemainingInMonth = (): number => {
  const d = new Date();
  return daysThisMonth() - d.getDate() + 1;    // today counts
};

// Mapping must stay in sync with backend NEEDS set used in the monthly review.
const NEEDS_CATS = new Set(['Food', 'Groceries', 'Transport', 'Bills', 'Health']);

/** Server tips arrive as plain sentences. Give each a level, title and icon-friendly shape. */
function fromServerTip(tip: string): Rec {
  if (/exceed 40%/i.test(tip)) return { level: 'danger', title: 'Fixed payments are above the 40% safe limit', text: tip };
  if (/at least 20%/i.test(tip)) return { level: 'warn', title: 'Savings are below the 20% target', text: tip };
  if (/No EMIs/i.test(tip)) return { level: 'success', title: 'No EMI burden', text: tip };
  if (/emergency fund/i.test(tip)) return { level: 'info', title: 'Build an emergency fund', text: tip };
  return { level: 'info', title: 'Tip', text: tip };
}

/**
 * Derived insights computed in the browser from the numbers the API already returns.
 * The API remains the source of truth for amounts (50/30/20 of what is left after fixed payments).
 */
export function buildInsights(plan: Plan, emis: Emi[]): Insights {
  const { income, emiTotal, afterFixed, breakdown } = plan;
  const spentThisMonth = Number(plan.spentThisMonth ?? 0);
  const byCategory = plan.byCategory ?? {};
  // Dynamic needs/wants spending — recomputed every time plan() returns, so
  // adding an expense reshapes these values on the next load.
  const spentOnNeeds = Object.entries(byCategory)
    .filter(([cat]) => NEEDS_CATS.has(cat))
    .reduce((s, [, v]) => s + Number(v || 0), 0);
  const spentOnWants = Math.max(0, spentThisMonth - spentOnNeeds);
  const overspentNeeds = Math.max(0, spentOnNeeds - breakdown.needs);
  const overspentWants = Math.max(0, spentOnWants - breakdown.wants);
  const actualSave = Math.max(0, income - emiTotal - spentThisMonth);

  if (income <= 0) {
    return {
      health: 'empty',
      emiRatio: 0,
      dailyAllowance: 0,
      dailyLeft: 0,
      daysRemaining: daysRemainingInMonth(),
      emergencyTarget: 0,
      spentOnNeeds: 0,
      spentOnWants: 0,
      actualSave: 0,
      overspentNeeds: 0,
      overspentWants: 0,
      recs: [
        {
          level: 'info',
          title: 'Enter your credited salary',
          text: 'Add the salary credited this month and your fixed payments to see a personalised plan.',
        },
      ],
    };
  }

  const emiRatio = emiTotal / income;
  const dailyAllowance = (breakdown.needs + breakdown.wants) / daysThisMonth();
  const daysRemaining = Math.max(1, daysRemainingInMonth());
  const remainingSpendBudget = Math.max(0, (breakdown.needs + breakdown.wants) - spentThisMonth);
  const dailyLeft = remainingSpendBudget / daysRemaining;
  const emergencyTarget = 6 * (emiTotal + breakdown.needs);

  // Base health on EMI ratio (fixed obligations) and degrade it when actual
  // spending overshoots the discretionary budget. A 50/30/20 plan is
  // meaningless if the user has already spent beyond needs+wants.
  let health: Health;
  if (afterFixed <= 0 || emiRatio > 0.6) health = 'critical';
  else if (emiRatio > 0.4) health = 'tight';
  else if (emiRatio > 0.3) health = 'good';
  else health = 'excellent';
  if (afterFixed > 0 && spentThisMonth > breakdown.needs + breakdown.wants) {
    // Overspent — knock health down one notch.
    health = health === 'excellent' ? 'tight'
           : health === 'good' ? 'tight'
           : 'critical';
  }

  const recs: Rec[] = [];
  if (afterFixed <= 0) {
    recs.push({
      level: 'danger',
      title: 'Fixed payments use your entire salary',
      text: `Fixed payments of ${inr(emiTotal)} leave nothing for food, travel or savings. Review which payments can be renegotiated, prepaid or closed.`,
    });
  }
  recs.push(...plan.tips.map(fromServerTip));
  if (emiRatio > 0.3 && emiRatio <= 0.4) {
    recs.push({
      level: 'warn',
      title: 'EMIs are getting heavy',
      text: `Fixed payments use ${Math.round(emiRatio * 100)}% of your salary. Keep new borrowing off the table until this drops below 30%.`,
    });
  }
  if (afterFixed > 0) {
    recs.push({
      level: 'success',
      title: 'Pay yourself first',
      text: `Move ${inr(breakdown.save)} to savings on salary day, before spending anything else.`,
    });
    recs.push({
      level: 'info',
      title: 'Daily spending guide',
      text: `Staying near ${inr(Math.round(dailyAllowance))} a day for food, travel and fun keeps you on plan this month.`,
    });
  }
  const subs = emis.filter((e) => e.category === 'Subscription').reduce((s, e) => s + e.amount, 0);
  if (subs > income * 0.05) {
    recs.push({
      level: 'warn',
      title: 'Subscriptions look high',
      text: `Subscriptions cost ${inr(subs)} a month (${Math.round((subs / income) * 100)}% of salary). Cancel anything unused for 30 days.`,
    });
  }
  if (!emis.some((e) => e.category === 'Insurance')) {
    recs.push({
      level: 'info',
      title: 'Check your insurance cover',
      text: 'No insurance payment is listed. Health and term cover protect your savings from one bad event.',
    });
  }
  return {
    health,
    emiRatio,
    dailyAllowance,
    dailyLeft,
    daysRemaining,
    emergencyTarget,
    spentOnNeeds,
    spentOnWants,
    actualSave,
    overspentNeeds,
    overspentWants,
    recs,
  };
}
