/**
 * Local-only test-data seeder. Fills your logged-in account with a realistic
 * month: 3 L salary, a stack of monthly bills, and ~200 expense entries
 * across all categories spread through the month. Lets you stress-test the
 * dashboard, insights, and spending history without hand-typing.
 *
 * SAFETY: refuses to run against anything other than a file: URL (i.e. your
 * local SQLite DB). Will never touch Turso prod even if you misconfigure the
 * env. Usage:
 *
 *   cd backend
 *   node scripts/seed-dev.js your@email.com [--count=200] [--salary=300000] [--reset]
 *
 *   --count   number of random expense entries (default 200)
 *   --salary  monthly take-home in rupees (default 300000)
 *   --reset   wipe existing salary + emis + expense_log for this user first
 */
import 'dotenv/config';
import db from '../src/db/index.js';

if (!String(process.env.TURSO_DATABASE_URL || '').startsWith('file:')) {
  console.error('[seed] refusing to run — TURSO_DATABASE_URL must be a local file: URL.');
  console.error('[seed] current:', process.env.TURSO_DATABASE_URL || '(unset)');
  process.exit(1);
}

const args = process.argv.slice(2);
const email = args.find((a) => a.includes('@'));
if (!email) {
  console.error('[seed] pass your account email as the first argument.');
  console.error('[seed]   node scripts/seed-dev.js you@example.com');
  process.exit(1);
}
const COUNT = Number((args.find((a) => a.startsWith('--count=')) || '--count=200').split('=')[1]);
const SALARY = Number((args.find((a) => a.startsWith('--salary=')) || '--salary=300000').split('=')[1]);
const RESET = args.includes('--reset');

const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Entertainment', 'Bills', 'Health', 'Travel', 'Education', 'Other'];
const BILLS = [
  { label: 'Rent',               amount: 35000, category: 'Rent' },
  { label: 'Home loan EMI',      amount: 22000, category: 'EMI' },
  { label: 'Term insurance',     amount: 2200,  category: 'Insurance' },
  { label: 'Health insurance',   amount: 1800,  category: 'Insurance' },
  { label: 'Electricity',        amount: 2500,  category: 'Utility' },
  { label: 'Broadband',          amount: 999,   category: 'Utility' },
  { label: 'Netflix',            amount: 649,   category: 'Subscription' },
  { label: 'Spotify',            amount: 149,   category: 'Subscription' },
  { label: 'Gym',                amount: 1500,  category: 'Subscription' },
];
// Note templates per category — just enough variety to feel real.
const NOTE_HINTS = {
  Food: ['lunch', 'dinner', 'coffee', 'swiggy', 'zomato', 'cafe'],
  Groceries: ['bigbasket', 'milk + bread', 'weekly haul', 'fruit mart', 'local kirana'],
  Transport: ['uber', 'metro top-up', 'ola', 'petrol', 'parking'],
  Shopping: ['amazon', 'myntra', 'kurta', 'shoes', 'headphones'],
  Entertainment: ['pvr', 'bookmyshow', 'live gig', 'netflix snack', 'board games'],
  Bills: ['phone recharge', 'water bill', 'maintenance'],
  Health: ['pharmacy', 'checkup', 'dentist', 'optician'],
  Travel: ['irctc', 'cab airport', 'weekend trip', 'bike rental'],
  Education: ['udemy', 'book', 'exam fee'],
  Other: ['gift', 'donation', 'misc'],
};

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randAmount(category) {
  const bands = {
    Food: [80, 1200],
    Groceries: [250, 2500],
    Transport: [50, 900],
    Shopping: [500, 6000],
    Entertainment: [200, 2500],
    Bills: [200, 2000],
    Health: [300, 4000],
    Travel: [1200, 15000],
    Education: [400, 3500],
    Other: [100, 1500],
  };
  const [lo, hi] = bands[category] || [100, 1500];
  return Math.round(lo + Math.random() * (hi - lo));
}

async function main() {
  const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`[seed] no user with email "${email}" in the local DB. Sign up first via the UI.`);
    process.exit(1);
  }
  const uid = Number(user.id);
  const month = monthKey();

  if (RESET) {
    console.log('[seed] --reset — wiping existing salary / emis / expenses for this user');
    await db.prepare('DELETE FROM expense_log WHERE user_id = ?').run(uid);
    await db.prepare('DELETE FROM emis WHERE user_id = ?').run(uid);
    await db.prepare('DELETE FROM salary_entries WHERE user_id = ?').run(uid);
  }

  // Salary
  await db
    .prepare(
      `INSERT INTO salary_entries (user_id, month, amount) VALUES (?, ?, ?)
       ON CONFLICT(user_id, month) DO UPDATE SET amount = excluded.amount`
    )
    .run(uid, month, SALARY);
  console.log(`[seed] set salary ₹${SALARY.toLocaleString('en-IN')} for ${month}`);

  // Bills — insert each if not already present (idempotent by label).
  for (const b of BILLS) {
    const existing = await db
      .prepare('SELECT 1 AS ok FROM emis WHERE user_id = ? AND label = ?')
      .get(uid, b.label);
    if (existing) continue;
    await db
      .prepare('INSERT INTO emis (user_id, label, amount, category) VALUES (?, ?, ?, ?)')
      .run(uid, b.label, b.amount, b.category);
  }
  const billTotal = BILLS.reduce((s, b) => s + b.amount, 0);
  console.log(`[seed] added ${BILLS.length} monthly bills totalling ₹${billTotal.toLocaleString('en-IN')}`);

  // Expenses — spread across current month, random categories.
  const now = new Date();
  const daysSoFar = now.getDate();
  let inserted = 0;
  for (let i = 0; i < COUNT; i++) {
    const day = 1 + Math.floor(Math.random() * daysSoFar);
    const spentOn = `${month}-${String(day).padStart(2, '0')}`;
    const category = pick(CATEGORIES);
    const amount = randAmount(category);
    const note = pick(NOTE_HINTS[category] || ['misc']);
    await db
      .prepare('INSERT INTO expense_log (user_id, month, category, amount, note, spent_on) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid, month, category, amount, note, spentOn);
    inserted++;
  }
  console.log(`[seed] inserted ${inserted} random expense entries across ${daysSoFar} days of ${month}`);

  const spentRow = await db
    .prepare('SELECT COALESCE(SUM(amount),0) AS t FROM expense_log WHERE user_id = ? AND month = ?')
    .get(uid, month);
  console.log(`[seed] total spent so far this month: ₹${Number(spentRow.t).toLocaleString('en-IN')}`);
  console.log('[seed] done — reload the dashboard.');
  process.exit(0);
}

main().catch((e) => { console.error('[seed] failed:', e); process.exit(1); });
