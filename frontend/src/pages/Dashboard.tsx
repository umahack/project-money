import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Donut, Empty, Field, Money, PageTitle, Spinner, burst } from '../components/ui';
import { buildInsights } from '../insights';
import { amountToInput, currentMonth, inr, monthLabel, parseAmount } from '../money';
import { errText, useAuth, useToast } from '../state';
import type { Emi, Plan } from '../types';
import { InvitesInbox } from '../components/InvitesInbox';
import { OnboardingModal } from '../components/OnboardingModal';

export const EMI_CATEGORIES = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'] as const;
const CAT_ICON: Record<string, string> = { EMI: '🏦', Rent: '🏠', Utility: '💡', Insurance: '🛡️', Subscription: '📺', Other: '📌' };
const HEALTH = {
  empty: { label: 'Waiting for salary', cls: 'info' },
  excellent: { label: 'Excellent', cls: 'success' },
  good: { label: 'Good', cls: 'success' },
  tight: { label: 'Tight', cls: 'warn' },
  critical: { label: 'Critical', cls: 'danger' },
} as const;
const LEVEL_ICON = { success: '✅', info: '💡', warn: '⚠️', danger: '🚨' } as const;

interface SalaryRes {
  salary: { month: string; amount: number } | null;
}

export function Dashboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [emis, setEmis] = useState<Emi[]>([]);
  const [salaryMonth, setSalaryMonth] = useState<string | null>(null);
  const [salary, setSalary] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>('EMI');
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, e, p] = await Promise.all([
        api.get<SalaryRes>('/finance/salary'),
        api.get<{ emis: Emi[] }>('/finance/emis'),
        api.get<Plan>('/finance/plan'),
      ]);
      setSalary(amountToInput(s.salary?.amount));
      setSalaryMonth(s.salary?.month ?? null);
      setEmis(e.emis);
      setPlan(p);
      setLoadErr('');
    } catch (err) {
      setLoadErr(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // One-time thank-you after leaving feedback on the previous sign-out.
  useEffect(() => {
    try {
      if (localStorage.getItem('pm_feedback_thanks') === '1') {
        localStorage.removeItem('pm_feedback_thanks');
        toast('ok', `Welcome back, ${user?.name.split(' ')[0] || 'friend'}. Thanks for the feedback last time!`);
      }
    } catch {
      /* storage blocked */
    }
  }, [toast, user?.name]);

  async function saveSalary(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = parseAmount(salary || '0');
    if (value === null) return toast('err', 'Enter a valid amount, e.g. 75000 or 75,000.50');
    setSaving(true);
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      await api.post('/finance/salary', { amount: value });
      await load();
      toast('ok', 'Salary saved. Your plan is updated.');
      if (value > 0) burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setSaving(false);
    }
  }

  async function addEmi(e: FormEvent) {
    e.preventDefault();
    const value = parseAmount(amount);
    if (!label.trim()) return toast('err', 'Give this payment a name');
    if (value === null || value <= 0) return toast('err', 'Enter a valid monthly amount');
    try {
      await api.post('/finance/emis', { label: label.trim(), amount: value, category });
      setLabel('');
      setAmount('');
      await load();
      toast('ok', 'Payment added');
    } catch (err) {
      toast('err', errText(err));
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/finance/emis/${id}`);
      await load();
    } catch (err) {
      toast('err', errText(err));
    }
  }

  const ins = useMemo(() => (plan ? buildInsights(plan, emis) : null), [plan, emis]);

  if (loadErr) return <Card><p className="form-error">{loadErr}</p><button className="btn" onClick={() => void load()}>Retry</button></Card>;
  if (!plan || !ins) return <Spinner />;

  const health = HEALTH[ins.health];
  const segments = [
    { label: 'Fixed payments', value: plan.emiTotal, color: 'var(--c-fixed)' },
    { label: 'Savings', value: plan.breakdown.save, color: 'var(--c-save)' },
    { label: 'Essentials', value: plan.breakdown.needs, color: 'var(--c-need)' },
    { label: 'Fun & flexible', value: plan.breakdown.wants, color: 'var(--c-want)' },
  ];
  const stale = salaryMonth && salaryMonth !== currentMonth();

  return (
    <>
      <PageTitle
        title={`Hello, ${user?.name.split(' ')[0] ?? 'there'} 👋`}
        sub="Enter this month's credited salary and your fixed payments. We'll plan the rest."
        right={salaryMonth ? <span className={`pill ${stale ? 'warn' : 'info'}`}>Salary on file: {monthLabel(salaryMonth)}</span> : undefined}
      />

      <InvitesInbox />

      <div className="grid two">
        <Card tilt>
          <h2>💳 Credited monthly salary</h2>
          <form onSubmit={saveSalary} className="salary-form">
            <div className="input-prefix">
              <span>₹</span>
              <input value={salary} onChange={(e) => setSalary(e.target.value)} inputMode="decimal" placeholder="75,000" aria-label="Credited monthly salary" maxLength={16} />
            </div>
            <motion.button className="btn primary" whileTap={{ scale: 0.95 }} disabled={saving} type="submit">
              {saving ? 'Saving…' : 'Calculate plan'}
            </motion.button>
          </form>
          {stale && <p className="small muted">Your last entry is for {monthLabel(salaryMonth!)}. Saving now records it for {monthLabel(currentMonth())}.</p>}
          <div className="stat-row">
            <div><span className="muted">Salary</span><Money value={plan.income} className="big" /></div>
            <div><span className="muted">Fixed payments</span><Money value={plan.emiTotal} className="big" /></div>
            <div><span className="muted">Left after fixed</span><Money value={plan.afterFixed} className="big" /></div>
          </div>
        </Card>

        <Card tilt>
          <div className="row between">
            <h2>📊 Your plan</h2>
            <span className={`pill ${health.cls}`}>{health.label}</span>
          </div>
          {plan.income > 0 ? (
            <div className="plan-grid">
              <Donut segments={segments} centerTop="Save this month" centerBottom={inr(plan.breakdown.save)} />
              <ul className="legend">
                {segments.map((s) => (
                  <li key={s.label}>
                    <i style={{ background: s.color }} />
                    <span>{s.label}</span>
                    <b className="mono">{inr(s.value)}</b>
                    <small className="muted">{Math.round((s.value / plan.income) * 100)}%</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Empty emoji="🪙" title="No salary yet" text="Add your credited salary to see where every rupee should go." />
          )}
          {plan.income > 0 && plan.afterFixed > 0 && (
            <div className="daily">
              <span>Safe daily spend</span>
              <Money value={Math.round(ins.dailyAllowance)} className="big accent" />
              <small className="muted">for food, travel and fun</small>
            </div>
          )}
          {plan.income > 0 && plan.afterFixed <= 0 && <p className="form-error">Fixed payments use all of your salary.</p>}
          {plan.income > 0 && <p className="small"><Link to="/plan">See the line-by-line plan →</Link></p>}
        </Card>
      </div>

      <div className="grid two">
        <Card>
          <h2>🧾 Mandatory EMIs &amp; monthly payments</h2>
          <form onSubmit={addEmi} className="commit-form">
            <Field label="What is it?">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home loan EMI" maxLength={60} />
            </Field>
            <Field label="Type">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {EMI_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Monthly amount (₹)">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="12,500" maxLength={16} />
            </Field>
            <div className="row">
              <button className="btn primary" type="submit">+ Add</button>
            </div>
          </form>
          {emis.length === 0 ? (
            <Empty emoji="🏦" title="No fixed payments yet" text="Add EMIs, rent, insurance and subscriptions so the plan stays honest." />
          ) : (
            <ul className="list">
              <AnimatePresence initial={false}>
                {emis.map((c) => (
                  <motion.li key={c.id} layout initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} className="list-item hoverable">
                    <span className="avatar">{CAT_ICON[c.category] ?? '📌'}</span>
                    <div className="grow">
                      <strong>{c.label}</strong>
                      <small className="muted">{c.category}</small>
                    </div>
                    <b className="mono">{inr(c.amount)}</b>
                    <button className="icon-btn danger" aria-label={`Delete ${c.label}`} onClick={() => void remove(c.id)}>🗑️</button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </Card>

        <Card>
          <h2>🧠 Recommendations</h2>
          <ul className="recs">
            {ins.recs.map((r, i) => (
              <motion.li key={r.title + i} className={`rec ${r.level}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <span className="rec-icon">{LEVEL_ICON[r.level]}</span>
                <div>
                  <strong>{r.title}</strong>
                  <p>{r.text}</p>
                </div>
              </motion.li>
            ))}
          </ul>
        </Card>
      </div>

      <OnboardingModal />
    </>
  );
}
