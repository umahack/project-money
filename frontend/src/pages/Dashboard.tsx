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
import { TodayStrip } from '../components/TodayStrip';

export const EMI_CATEGORIES = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'] as const;
const CAT_ICON: Record<string, string> = { EMI: '🏦', Rent: '🏠', Utility: '💡', Insurance: '🛡️', Subscription: '📺', Other: '📌' };
const HEALTH = {
  empty: { label: 'Waiting for your pay', cls: 'info' },
  excellent: { label: 'Looking great 🎉', cls: 'success' },
  good: { label: "You're good 👍", cls: 'success' },
  tight: { label: 'A bit tight 😬', cls: 'warn' },
  critical: { label: 'Rough month 🚨', cls: 'danger' },
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
    { label: 'Bills', value: plan.emiTotal, color: 'var(--c-fixed)' },
    { label: 'Save 💰', value: plan.breakdown.save, color: 'var(--c-save)' },
    { label: 'Needs 🍔', value: plan.breakdown.needs, color: 'var(--c-need)' },
    { label: 'Wants 🎮', value: plan.breakdown.wants, color: 'var(--c-want)' },
  ];
  const stale = salaryMonth && salaryMonth !== currentMonth();
  const firstName = user?.name.split(' ')[0] ?? 'there';
  const hasPay = plan.income > 0;
  const hasBills = emis.length > 0;

  // ----- Brand-new user: single hero card that walks them through step 1. -----
  if (!hasPay) {
    return (
      <>
        <PageTitle title={`Hey ${firstName} 👋`} sub="Two quick things and your plan is ready." />
        <TodayStrip />
        <InvitesInbox />
        <Card tilt>
          <div style={{ textAlign: 'center', padding: '0.4rem 0 0.8rem' }}>
            <div style={{ fontSize: '3rem', lineHeight: 1 }}>💰</div>
            <h2 style={{ margin: '0.4rem 0 0.2rem' }}>Step 1 · Your monthly pay</h2>
            <p className="muted" style={{ margin: 0, maxWidth: 440, marginInline: 'auto' }}>
              How much lands in your bank each month after tax? Just the take-home number.
            </p>
          </div>
          <form onSubmit={saveSalary} className="salary-form">
            <div className="input-prefix">
              <span>₹</span>
              <input value={salary} onChange={(e) => setSalary(e.target.value)} inputMode="decimal" placeholder="e.g. 75,000" aria-label="Monthly pay" maxLength={16} autoFocus />
            </div>
            <motion.button className="btn primary" whileTap={{ scale: 0.95 }} disabled={saving} type="submit">
              {saving ? 'Saving…' : 'Save and continue →'}
            </motion.button>
          </form>
          <p className="muted tiny center" style={{ marginTop: '0.8rem' }}>
            🔒 Only you can see this. Change it any time.
          </p>
        </Card>
        <OnboardingModal />
      </>
    );
  }

  // ----- Pay set, no bills yet: nudge Step 2. -----
  if (!hasBills) {
    return (
      <>
        <PageTitle
          title={`Hey ${firstName} 👋`}
          sub="One more step — add anything that leaves your bank on its own."
          right={<span className="pill info">Pay: {inr(plan.income)}</span>}
        />
        <TodayStrip />
        <InvitesInbox />
        <Card>
          <div style={{ textAlign: 'center', padding: '0.2rem 0 0.6rem' }}>
            <div style={{ fontSize: '2.6rem', lineHeight: 1 }}>📄</div>
            <h2 style={{ margin: '0.4rem 0 0.2rem' }}>Step 2 · Monthly bills</h2>
            <p className="muted" style={{ margin: 0, maxWidth: 460, marginInline: 'auto' }}>
              Rent, Netflix, insurance, loan EMIs — anything that leaves your account automatically.
              Nothing recurring? Hit skip at the bottom.
            </p>
          </div>
          <form onSubmit={addEmi} className="commit-form">
            <Field label="What is it?">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Rent, Netflix, Health insurance" maxLength={60} />
            </Field>
            <Field label="Type">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {EMI_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="How much (₹) a month">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="e.g. 12,500" maxLength={16} />
            </Field>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.6rem' }}>
              <button className="btn ghost" type="button" onClick={() => void load()}>
                No bills — skip
              </button>
              <button className="btn primary" type="submit">+ Add bill</button>
            </div>
          </form>
        </Card>
        <OnboardingModal />
      </>
    );
  }

  // ----- Normal state: pay + at least one bill. -----
  return (
    <>
      <PageTitle
        title={`Hey ${firstName} 👋`}
        sub="Here's where your money is going this month."
        right={salaryMonth ? <span className={`pill ${stale ? 'warn' : 'info'}`}>Pay for {monthLabel(salaryMonth)}</span> : undefined}
      />

      <TodayStrip />
      <InvitesInbox />

      {/* HERO: the plan donut + one big "left to spend/save" number. */}
      <Card tilt>
        <div className="row between" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
          <h2 style={{ margin: 0 }}>📊 Your money this month</h2>
          <span className={`pill ${health.cls}`}>{health.label}</span>
        </div>
        {plan.afterFixed > 0 ? (
          <>
            <div className="plan-grid">
              <Donut segments={segments} centerTop="To save" centerBottom={inr(plan.breakdown.save)} />
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
            <div className="daily" style={{ marginTop: '0.6rem' }}>
              <span>Safe to spend per day</span>
              <Money value={Math.round(ins.dailyAllowance)} className="big accent" />
              <small className="muted">on food, travel and fun · {inr(plan.spentThisMonth ?? 0)} spent so far</small>
            </div>
            <p className="small" style={{ marginTop: '0.4rem' }}>
              <Link to="/plan">See line-by-line plan →</Link> · <Link to="/spending">Log today's spend →</Link>
            </p>
          </>
        ) : (
          <Empty emoji="⚠️" title="Your bills use all of your pay" text="Review which bills can be renegotiated, downgraded, or paused." />
        )}
      </Card>

      {/* QUICK UPDATE: salary + add-bill side-by-side, compact. */}
      <div className="grid two">
        <Card>
          <h2>💰 Monthly pay</h2>
          <form onSubmit={saveSalary} className="salary-form">
            <div className="input-prefix">
              <span>₹</span>
              <input value={salary} onChange={(e) => setSalary(e.target.value)} inputMode="decimal" placeholder="75,000" aria-label="Monthly pay" maxLength={16} />
            </div>
            <motion.button className="btn primary" whileTap={{ scale: 0.95 }} disabled={saving} type="submit">
              {saving ? 'Saving…' : stale ? 'Update' : 'Save'}
            </motion.button>
          </form>
          {stale && <p className="small muted">Updating saves it for {monthLabel(currentMonth())}.</p>}
          <div className="stat-row">
            <div><span className="muted">Pay</span><Money value={plan.income} className="big" /></div>
            <div><span className="muted">Bills</span><Money value={plan.emiTotal} className="big" /></div>
            <div><span className="muted">Left over</span><Money value={plan.afterFixed} className="big" /></div>
          </div>
        </Card>

        <Card>
          <h2>📄 Monthly bills</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Rent, EMIs, subscriptions, insurance — anything auto-deducted.</p>
          <form onSubmit={addEmi} className="commit-form">
            <Field label="What is it?">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Netflix" maxLength={60} />
            </Field>
            <Field label="Type">
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {EMI_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="₹ per month">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="649" maxLength={16} />
            </Field>
            <div className="row">
              <button className="btn primary" type="submit">+ Add bill</button>
            </div>
          </form>
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
        </Card>
      </div>

      <Card>
        <h2>💡 Tips for you</h2>
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

      <OnboardingModal />
    </>
  );
}
