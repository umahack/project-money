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
  dailyAllowance: number;
  emergencyTarget: number;
  recs: Rec[];
}

const daysThisMonth = (): number => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

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
  if (income <= 0) {
    return {
      health: 'empty',
      emiRatio: 0,
      dailyAllowance: 0,
      emergencyTarget: 0,
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
  const emergencyTarget = 6 * (emiTotal + breakdown.needs);

  let health: Health;
  if (afterFixed <= 0 || emiRatio > 0.6) health = 'critical';
  else if (emiRatio > 0.4) health = 'tight';
  else if (emiRatio > 0.3) health = 'good';
  else health = 'excellent';

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
  return { health, emiRatio, dailyAllowance, emergencyTarget, recs };
}
