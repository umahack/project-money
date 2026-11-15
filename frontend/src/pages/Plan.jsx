import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api/client.js';

const money = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(
    Math.max(0, Math.round(n || 0))
  );

const NEEDS = [
  { key: 'rent', label: 'Rent / Housing', pct: 0.30, tip: 'Target ≤ 30% of take-home. Share rent to free up savings.' },
  { key: 'groceries', label: 'Groceries & Household', pct: 0.22, tip: 'Plan a weekly menu. Batch cook to cut food waste.' },
  { key: 'transport', label: 'Transport / Fuel', pct: 0.14, tip: 'Carpool or metro passes trim this 20–30% monthly.' },
  { key: 'utilities', label: 'Utilities & Internet', pct: 0.10, tip: 'Audit bills once a quarter; switch to annual plans where cheaper.' },
  { key: 'insurance', label: 'Health / Term Insurance', pct: 0.08, tip: 'Lock in term + health young — premiums rise sharply with age.' },
  { key: 'medical', label: 'Medical / Pharmacy', pct: 0.06, tip: 'Keep a ₹10–20k buffer for sudden visits and prescriptions.' },
  { key: 'misc_needs', label: 'Other Essentials', pct: 0.10, tip: 'Toiletries, repairs, pet care, EMIs not already captured.' },
];

const WANTS = [
  { key: 'dining', label: 'Dining Out', pct: 0.30, tip: 'Cap the "coffee + delivery" drip — it quietly beats rent.' },
  { key: 'entertainment', label: 'Entertainment', pct: 0.20, tip: 'Movies, concerts, games. Set a monthly cap and stick.' },
  { key: 'shopping', label: 'Shopping & Lifestyle', pct: 0.25, tip: 'Use a 48-hour cool-off rule on anything above ₹2000.' },
  { key: 'subscriptions', label: 'Subscriptions', pct: 0.10, tip: 'Audit OTT/music/apps every 3 months. Share family plans.' },
  { key: 'personal_care', label: 'Personal Care', pct: 0.10, tip: 'Haircuts, gym, grooming — rotate between premium and basic.' },
  { key: 'gifting', label: 'Gifts & Social', pct: 0.05, tip: 'Pool for birthdays; set a per-event ceiling.' },
];

const SAVINGS = [
  { key: 'emergency', label: 'Emergency Fund', pct: 0.30, tip: 'Build to 6 months of fixed expenses in a liquid account.' },
  { key: 'sip', label: 'SIP / Mutual Funds', pct: 0.35, tip: 'Index + flexi-cap SIPs. Automate on salary day.' },
  { key: 'retirement', label: 'Retirement (NPS / EPF)', pct: 0.15, tip: 'NPS Tier-1 adds a tax edge on top of EPF.' },
  { key: 'goals', label: 'Short-term Goals', pct: 0.10, tip: 'Trip / gadget / course — park in short-duration debt funds.' },
  { key: 'learning', label: 'Learning & Skills', pct: 0.05, tip: 'Courses & books. Highest ROI line in the whole plan.' },
  { key: 'charity', label: 'Giving', pct: 0.05, tip: 'Even ₹500/month compounds into real impact over a decade.' },
];

export default function Plan() {
  const [plan, setPlan] = useState(null);
  const [emis, setEmis] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [p, e] = await Promise.all([api('/finance/plan'), api('/finance/emis')]);
        setPlan(p);
        setEmis(e.emis);
      } catch (e) { setErr(e.message); }
    })();
  }, []);

  if (err) return <div className="text-rose-400">{err}</div>;
  if (!plan) return <div className="text-white/80">Loading your plan…</div>;

  const income = plan.income || 0;
  const needsTotal = plan.breakdown.needs;
  const wantsTotal = plan.breakdown.wants;
  const saveTotal = plan.breakdown.save;
  const emergency = Math.round((plan.emiTotal + needsTotal) * 6);

  if (!income) {
    return (
      <div className="card">
        <h1 className="text-2xl font-bold text-white">Expense Plan</h1>
        <p className="text-white/80 mt-2">Add your salary on the Dashboard to generate a detailed plan.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card">
        <h1 className="text-2xl font-bold text-white">Your month, line by line</h1>
        <p className="text-white/80 mt-1 text-sm">
          Based on {money(income)}/month after {money(plan.emiTotal)} in mandatory payments.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <Totals label="Income" value={money(income)} tint="text-mint" />
          <Totals label="Fixed / EMIs" value={money(plan.emiTotal)} tint="text-rose-300" />
          <Totals label="Disposable" value={money(plan.afterFixed)} tint="text-amber-300" />
          <Totals label="Target Emergency Fund" value={money(emergency)} tint="text-orchid" />
        </div>
      </motion.div>

      <Section
        title="What to spend on (Essentials — 50% of disposable)"
        subtotal={money(needsTotal)}
        pool={needsTotal}
        items={NEEDS}
        accent="from-emerald-500/30 to-emerald-500/0"
      />

      <Section
        title="What you can enjoy (Lifestyle — 30% of disposable)"
        subtotal={money(wantsTotal)}
        pool={wantsTotal}
        items={WANTS}
        accent="from-fuchsia-500/30 to-fuchsia-500/0"
      />

      <Section
        title="What to save & invest (20% of disposable)"
        subtotal={money(saveTotal)}
        pool={saveTotal}
        items={SAVINGS}
        accent="from-amber-500/30 to-amber-500/0"
      />

      <motion.div className="card" whileHover={{ y: -2 }}>
        <h2 className="text-lg font-semibold text-white">Your mandatory payments</h2>
        <p className="text-white/70 text-sm mb-3">
          These are deducted <em>before</em> the 50/30/20 split. Keep this total under 40% of income.
        </p>
        {emis.length ? (
          <ul className="divide-y divide-white/10">
            {emis.map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2">
                <div className="text-white">{e.label} <span className="pill ml-1">{e.category}</span></div>
                <div className="font-semibold text-white">{money(e.amount)}</div>
              </li>
            ))}
            <li className="flex items-center justify-between py-2">
              <div className="text-white/80">Total</div>
              <div className="font-bold text-white">{money(plan.emiTotal)}</div>
            </li>
          </ul>
        ) : (
          <div className="text-white/70">No mandatory payments added yet. Add them from the Dashboard.</div>
        )}
      </motion.div>

      <motion.div className="card" whileHover={{ y: -2 }}>
        <h2 className="text-lg font-semibold text-white">Smart recommendations</h2>
        <ul className="list-disc pl-5 text-white/90 space-y-1 mt-2">
          {plan.tips.map((t, i) => <li key={i}>{t}</li>)}
          <li>Automate a transfer of <b>{money(saveTotal)}</b> to savings on salary day — pay yourself first.</li>
          <li>Keep <b>{money(emergency)}</b> as an emergency fund target before scaling discretionary spend.</li>
          <li>Review and rebalance this plan every quarter, or after any raise/EMI change.</li>
        </ul>
      </motion.div>
    </div>
  );
}

function Totals({ label, value, tint }) {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 p-3">
      <div className="text-xs uppercase tracking-wider text-white/70">{label}</div>
      <div className={`text-xl font-bold ${tint}`}>{value}</div>
    </div>
  );
}

function Section({ title, subtotal, pool, items, accent }) {
  const totalPct = items.reduce((a, b) => a + b.pct, 0) || 1;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="card relative overflow-hidden"
    >
      <div className={`absolute -top-16 -right-16 w-56 h-56 rounded-full blur-3xl bg-gradient-to-br ${accent}`} />
      <div className="relative flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <span className="pill text-white">{subtotal} / month</span>
      </div>
      <div className="relative grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((it) => {
          const amt = (pool * it.pct) / totalPct;
          return (
            <motion.div
              key={it.key}
              whileHover={{ y: -2, scale: 1.01 }}
              className="rounded-xl bg-white/5 border border-white/10 p-3"
            >
              <div className="flex items-center justify-between">
                <div className="font-medium text-white">{it.label}</div>
                <div className="font-semibold text-mint">{money(amt)}</div>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full mt-2 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-mint via-orchid to-amber"
                  style={{ width: `${Math.round((it.pct / totalPct) * 100)}%` }}
                />
              </div>
              <div className="text-xs text-white/70 mt-2">{it.tip}</div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
