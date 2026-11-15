import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card, Empty, PageTitle, Spinner } from '../components/ui';
import { buildInsights } from '../insights';
import { inr } from '../money';
import { errText } from '../state';
import type { Emi, Plan as PlanData } from '../types';

interface Line {
  key: string;
  label: string;
  icon: string;
  pct: number;
  tip: string;
}

const NEEDS: Line[] = [
  { key: 'rent', label: 'Rent / Housing', icon: '🏠', pct: 0.3, tip: 'Target at most 30% of take-home. Share rent to free up savings.' },
  { key: 'groceries', label: 'Groceries & Household', icon: '🛒', pct: 0.22, tip: 'Plan a weekly menu. Batch cook to cut food waste.' },
  { key: 'transport', label: 'Transport / Fuel', icon: '🚌', pct: 0.14, tip: 'Carpool or metro passes trim this 20–30% monthly.' },
  { key: 'utilities', label: 'Utilities & Internet', icon: '💡', pct: 0.1, tip: 'Audit bills once a quarter; switch to annual plans where cheaper.' },
  { key: 'insurance', label: 'Health / Term Insurance', icon: '🛡️', pct: 0.08, tip: 'Lock in term and health cover young. Premiums rise sharply with age.' },
  { key: 'medical', label: 'Medical / Pharmacy', icon: '💊', pct: 0.06, tip: 'Keep a ₹10–20k buffer for sudden visits and prescriptions.' },
  { key: 'misc_needs', label: 'Other Essentials', icon: '🧰', pct: 0.1, tip: 'Toiletries, repairs, pet care, EMIs not already captured.' },
];
const WANTS: Line[] = [
  { key: 'dining', label: 'Dining Out', icon: '🍽️', pct: 0.3, tip: 'Cap the "coffee + delivery" drip. It quietly beats rent.' },
  { key: 'entertainment', label: 'Entertainment', icon: '🎬', pct: 0.2, tip: 'Movies, concerts, games. Set a monthly cap and stick to it.' },
  { key: 'shopping', label: 'Shopping & Lifestyle', icon: '🛍️', pct: 0.25, tip: 'Use a 48-hour cool-off rule on anything above ₹2000.' },
  { key: 'subscriptions', label: 'Subscriptions', icon: '📺', pct: 0.1, tip: 'Audit OTT, music and apps every 3 months. Share family plans.' },
  { key: 'personal_care', label: 'Personal Care', icon: '💈', pct: 0.1, tip: 'Haircuts, gym, grooming. Rotate between premium and basic.' },
  { key: 'gifting', label: 'Gifts & Social', icon: '🎁', pct: 0.05, tip: 'Pool for birthdays and set a per-event ceiling.' },
];
const SAVINGS: Line[] = [
  { key: 'emergency', label: 'Emergency Fund', icon: '🚑', pct: 0.3, tip: 'Build to 6 months of fixed expenses in a liquid account.' },
  { key: 'sip', label: 'SIP / Mutual Funds', icon: '📈', pct: 0.35, tip: 'Index and flexi-cap SIPs. Automate on salary day.' },
  { key: 'retirement', label: 'Retirement (NPS / EPF)', icon: '🌴', pct: 0.15, tip: 'NPS Tier-1 adds a tax edge on top of EPF.' },
  { key: 'goals', label: 'Short-term Goals', icon: '🎯', pct: 0.1, tip: 'Trip, gadget or course. Park it in short-duration debt funds.' },
  { key: 'learning', label: 'Learning & Skills', icon: '📚', pct: 0.05, tip: 'Courses and books. The highest-return line in the whole plan.' },
  { key: 'charity', label: 'Giving', icon: '🤲', pct: 0.05, tip: 'Even ₹500 a month compounds into real impact over a decade.' },
];

export function Plan() {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [emis, setEmis] = useState<Emi[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [p, e] = await Promise.all([api.get<PlanData>('/finance/plan'), api.get<{ emis: Emi[] }>('/finance/emis')]);
        setPlan(p);
        setEmis(e.emis);
      } catch (e) {
        setErr(errText(e));
      }
    })();
  }, []);

  const ins = useMemo(() => (plan ? buildInsights(plan, emis) : null), [plan, emis]);

  if (err) return <Card><p className="form-error">{err}</p></Card>;
  if (!plan || !ins) return <Spinner />;

  if (!plan.income) {
    return (
      <>
        <PageTitle title="Expense plan 🧾" />
        <Card>
          <Empty emoji="🪙" title="No plan yet" text="Add your salary on the Home page to generate a detailed plan." />
          <div className="center"><Link className="btn primary" to="/">Go to Home</Link></div>
        </Card>
      </>
    );
  }

  const { needs, wants, save } = plan.breakdown;
  return (
    <>
      <PageTitle title="Your month, line by line 🧾" sub={`Based on ${inr(plan.income)} a month, after ${inr(plan.emiTotal)} in mandatory payments.`} />

      <Card tilt>
        <div className="grid four">
          <Total label="Income" value={inr(plan.income)} tone="ok" />
          <Total label="Fixed / EMIs" value={inr(plan.emiTotal)} tone="bad" />
          <Total label="Disposable" value={inr(plan.afterFixed)} tone="warn" />
          <Total label="Emergency fund target" value={inr(ins.emergencyTarget)} tone="info" />
        </div>
      </Card>

      <div className="stack gap-top">
        <Section title="What to spend on" sub="Essentials · 50% of disposable" subtotal={needs} items={NEEDS} color="var(--c-need)" />
        <Section title="What you can enjoy" sub="Lifestyle · 30% of disposable" subtotal={wants} items={WANTS} color="var(--c-want)" />
        <Section title="What to save and invest" sub="20% of disposable" subtotal={save} items={SAVINGS} color="var(--c-save)" />

        <div className="grid two">
          <Card>
            <h2>🏦 Your mandatory payments</h2>
            <p className="muted small">These come out <em>before</em> the 50/30/20 split. Keep the total under 40% of income.</p>
            {emis.length ? (
              <ul className="list">
                {emis.map((e) => (
                  <li key={e.id} className="list-item">
                    <div className="grow"><strong>{e.label}</strong><small className="muted">{e.category}</small></div>
                    <b className="mono">{inr(e.amount)}</b>
                  </li>
                ))}
                <li className="list-item total-row">
                  <div className="grow"><strong>Total</strong></div>
                  <b className="mono">{inr(plan.emiTotal)}</b>
                </li>
              </ul>
            ) : (
              <Empty emoji="🏦" title="No mandatory payments added yet" text="Add them from the Home page." />
            )}
          </Card>
          <Card>
            <h2>🧠 Smart recommendations</h2>
            <ul className="recs">
              {ins.recs.map((r, i) => (
                <li key={r.title + i} className={`rec ${r.level}`}>
                  <div>
                    <strong>{r.title}</strong>
                    <p>{r.text}</p>
                  </div>
                </li>
              ))}
              <li className="rec info"><div><strong>Review every quarter</strong><p>Rebalance this plan every three months, or after any raise or EMI change.</p></div></li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'bad' | 'warn' | 'info' }) {
  return (
    <div className={`total tone-${tone}`}>
      <span className="muted">{label}</span>
      <strong className="mono">{value}</strong>
    </div>
  );
}

function Section({ title, sub, subtotal, items, color }: { title: string; sub: string; subtotal: number; items: Line[]; color: string }) {
  const totalPct = items.reduce((a, b) => a + b.pct, 0) || 1;
  return (
    <Card>
      <div className="row between wrap">
        <div>
          <h2>{title}</h2>
          <p className="muted small">{sub}</p>
        </div>
        <span className="pill" style={{ color }}>{inr(subtotal)} / month</span>
      </div>
      <div className="grid three tiles">
        {items.map((it, i) => {
          const share = it.pct / totalPct;
          return (
            <motion.div key={it.key} className="tile" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <div className="row between">
                <span><span className="tile-icon">{it.icon}</span> <strong>{it.label}</strong></span>
                <b className="mono" style={{ color }}>{inr(subtotal * share)}</b>
              </div>
              <div className="bar-track"><motion.div className="bar-fill" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${Math.round(share * 100)}%` }} transition={{ duration: 0.8 }} /></div>
              <p className="muted small">{it.tip}</p>
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}
