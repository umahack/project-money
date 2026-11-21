import type { Plan, Emi } from './types';

// "Rohan's month" — a plausible mid-career Bangalore salary and lifestyle.
// Used to render the Dashboard the instant a brand-new user lands, so the
// value of the app is visible BEFORE we ever ask them to type anything.
// The moment they enter their own salary the demo is replaced with their
// real plan.

const DEMO_INCOME = 120000;
const DEMO_EMIS: Emi[] = [
  { id: -1, label: 'Rent — HSR 2BHK', amount: 28000, category: 'Rent' },
  { id: -2, label: 'Car EMI', amount: 14000, category: 'EMI' },
  { id: -3, label: 'Netflix + Spotify + YouTube Premium', amount: 1200, category: 'Subscription' },
  { id: -4, label: 'Health insurance', amount: 1800, category: 'Insurance' },
  { id: -5, label: 'Internet + Mobile', amount: 2000, category: 'Utility' },
];

const EMI_TOTAL = DEMO_EMIS.reduce((s, e) => s + e.amount, 0);
const AFTER_FIXED = DEMO_INCOME - EMI_TOTAL;
const SPENT_SO_FAR = Math.round(AFTER_FIXED * 0.46);  // ~46% through the month

export const DEMO_PLAN: Plan = {
  income: DEMO_INCOME,
  emiTotal: EMI_TOTAL,
  afterFixed: AFTER_FIXED,
  breakdown: {
    needs: Math.round(AFTER_FIXED * 0.5),
    wants: Math.round(AFTER_FIXED * 0.3),
    save: Math.round(AFTER_FIXED * 0.2),
  },
  tips: [
    'Fixed payments are about 39% of pay — comfortable, but keep new borrowing off the table.',
    'Keep an emergency fund of 6 months of fixed expenses in a liquid account.',
  ],
  month: new Date().toISOString().slice(0, 7),
  spentThisMonth: SPENT_SO_FAR,
  byCategory: {
    Food: 6400,
    Groceries: 4200,
    Transport: 1800,
    Shopping: 5100,
    Entertainment: 2400,
    Bills: 900,
  },
};

export const DEMO_SAMPLE_NAME = 'Rohan';
