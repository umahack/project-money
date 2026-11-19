import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card, Donut, Empty, Money, PageTitle, burst } from '../components/ui';
import { buildInsights } from '../insights';
import { amountToInput, currentMonth, inr, monthLabel, parseAmount } from '../money';
import { errText, useAuth, useToast } from '../state';
import type { Emi, Plan } from '../types';
import { InvitesInbox } from '../components/InvitesInbox';
import { StreakCard } from '../components/StreakCard';
import { QuickActions } from '../components/QuickActions';
import { FiveYearProjection } from '../components/FiveYearProjection';
import { DEMO_PLAN, DEMO_SAMPLE_NAME } from '../demoData';
import { readCachedPlan, writeCachedPlan } from '../hooks/useCachedPlan';

// Precomputed once — the demo plan is immutable, so there is no need to
// re-run buildInsights on every render in demo mode.
const DEMO_INSIGHTS = buildInsights(DEMO_PLAN, []);

/** Compact progress pill — "₹X of ₹Y" with a gradient fill clamped to 100%. */
function SpendBar({ spent, budget, color }: { spent: number; budget: number; color: string }) {
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const over = spent > budget && budget > 0;
  return (
    <div className="spend-bar" aria-label={`${pct}% of budget used`}>
      <div
        className="spend-bar-fill"
        style={{
          width: `${pct}%`,
          background: over ? 'linear-gradient(90deg, #ff5c7c, #e11d48)' : color,
        }}
      />
      <span className={`spend-bar-pct ${over ? 'over' : ''}`}>{pct}%</span>
    </div>
  );
}

export const EMI_CATEGORIES = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'] as const;
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
  // Hydrate from last-known cache so a tab-reload shows real numbers
  // instead of a skeleton. The cache is uid+month-guarded and tab-scoped
  // (sessionStorage) so a cached plan never leaks across users or months.
  const cached = useMemo(() => readCachedPlan(), []);
  const [plan, setPlan] = useState<Plan | null>(cached.plan);
  const [emis, setEmis] = useState<Emi[]>(cached.emis ?? []);
  const [salaryMonth, setSalaryMonth] = useState<string | null>(null);
  const [salary, setSalary] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  // Flip only after the first server response. We refuse to drop into demo
  // mode while the first fetch is still in flight — otherwise returning
  // users with an empty cache would briefly see "Rohan's month" instead of
  // a quiet loading state.
  const [loaded, setLoaded] = useState<boolean>(cached.plan !== null);

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
      writeCachedPlan(p, e.emis);
      setLoaded(true);
      setLoadErr('');
    } catch (err) {
      setLoadErr(errText(err));
      setLoaded(true);
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
    // Reject 0 explicitly: a successful POST with amount=0 would wipe the
    // user's real plan back to demo mode, which looks destructive even
    // though their bills are still on the server. Edit flow lives on /plan.
    if (value <= 0) return toast('err', 'Enter a positive amount');
    setSaving(true);
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      await api.post('/finance/salary', { amount: value });
      await load();
      toast('ok', 'Salary saved. Your plan is updated.');
      burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setSaving(false);
    }
  }

  const ins = useMemo(() => (plan ? buildInsights(plan, emis) : null), [plan, emis]);
  const firstName = user?.name.split(' ')[0] ?? 'there';

  if (loadErr) return <Card><p className="form-error">{loadErr}</p><button className="btn" onClick={() => void load()}>Retry</button></Card>;

  // Pre-first-fetch: show a quiet "loading" PageTitle so returning users
  // whose cache was cleared (sign-out, cross-user) don't briefly see
  // "Rohan's month" and think their real plan was wiped.
  if (!loaded && !plan) {
    return (
      <>
        <PageTitle title={`Hey ${firstName} 👋`} sub="Pulling your month together…" />
        <p className="muted small center" style={{ marginTop: '0.8rem' }} aria-live="polite">
          If this takes a few seconds, the free API host is waking up.
        </p>
      </>
    );
  }

  // Demo mode kicks in only AFTER the first server response confirms the
  // user hasn't set their pay. We never fall into demo during loading.
  const demoMode = loaded && (!plan || plan.income <= 0);
  const displayPlan: Plan = demoMode ? DEMO_PLAN : plan!;
  const displayIns = demoMode ? DEMO_INSIGHTS : ins!;
  const health = HEALTH[displayIns.health];
  const segments = [
    { label: 'Bills', value: displayPlan.emiTotal, color: 'var(--c-fixed)' },
    { label: 'Save 💰', value: displayPlan.breakdown.save, color: 'var(--c-save)' },
    { label: 'Needs 🍔', value: displayPlan.breakdown.needs, color: 'var(--c-need)' },
    { label: 'Wants 🎮', value: displayPlan.breakdown.wants, color: 'var(--c-want)' },
  ];
  const stale = salaryMonth && salaryMonth !== currentMonth();
  const hasBills = emis.length > 0;

  return (
    <>
      <PageTitle
        title={`Hey ${firstName} 👋`}
        sub={demoMode
          ? `This is ${DEMO_SAMPLE_NAME}'s month. Enter your salary below to see yours.`
          : "Here's where your money is going this month."}
        right={!demoMode && salaryMonth ? <span className={`pill ${stale ? 'warn' : 'info'}`}>Pay for {monthLabel(salaryMonth)}</span> : undefined}
      />

      {demoMode ? (
        <Card tilt className="demo-banner" style={{ borderColor: 'var(--accent)', boxShadow: '0 0 0 2px rgba(124,108,255,0.2)' }}>
          <div className="row between wrap" style={{ gap: '0.6rem', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: 0 }}>👇 Make it yours in one number</h2>
              <p className="muted small" style={{ margin: '0.2rem 0 0' }}>
                Everything below is a sample plan for ₹{DEMO_PLAN.income.toLocaleString('en-IN')} a month.
                Enter your take-home and the whole page becomes you.
              </p>
            </div>
          </div>
          <form onSubmit={saveSalary} className="salary-form" style={{ marginTop: '0.6rem' }}>
            <div className="input-prefix">
              <span>₹</span>
              <input
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                inputMode="decimal"
                placeholder="your monthly take-home, e.g. 75,000"
                aria-label="Monthly pay"
                maxLength={16}
                autoFocus
              />
            </div>
            <motion.button className="btn primary" whileTap={{ scale: 0.95 }} disabled={saving} type="submit">
              {saving ? 'Saving…' : 'Show my real plan →'}
            </motion.button>
          </form>
          <p className="muted tiny" style={{ margin: '0.6rem 0 0' }}>
            🔒 Only you can see this · Change it anytime · No tax math, no bank linking
          </p>
        </Card>
      ) : (
        <>
          <QuickActions />
          <StreakCard />
          <InvitesInbox />
        </>
      )}

      {!demoMode && !hasBills && (
        <div
          className="info-banner"
          style={{
            background: 'linear-gradient(135deg, rgba(124,108,255,0.1), rgba(16,185,129,0.08))',
            border: '1px solid rgba(124,108,255,0.3)',
            borderRadius: 12,
            padding: '0.7rem 0.9rem',
            marginBottom: '0.8rem',
            fontSize: '0.9rem',
          }}
        >
          💡 Your plan doesn't know your fixed bills yet (rent, Netflix, EMIs).
          {' '}<Link className="link" to="/plan#bills-form">Add them →</Link>{' '}
          — your daily-spend number will get sharper.
        </div>
      )}

      {/* HERO: donut + actual-vs-budget. Renders identically in demo + real
          mode — the visual payoff is the same. */}
      <Card tilt>
        <div className="row between" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
          <h2 style={{ margin: 0 }}>📊 {demoMode ? `${DEMO_SAMPLE_NAME}'s money this month` : 'Your money this month'}</h2>
          <span className={`pill ${health.cls}`}>{health.label}</span>
        </div>
        <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.2rem', alignItems: 'baseline' }}>
          <small className="muted">Pay</small>
          <strong className="mono">{inr(displayPlan.income)}</strong>
          {!demoMode && (
            <Link
              to="/plan#pay-form"
              className="btn ghost sm"
              style={{ padding: '0.2rem 0.6rem', minHeight: 'auto', fontSize: '0.78rem' }}
              title="Change your pay on the Plan page"
            >
              ✏️ Edit
            </Link>
          )}
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            Day {new Date().getDate()} of {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()}
          </span>
        </div>
        <div className="today-progress" aria-hidden="true" style={{ marginTop: '0.5rem' }}>
          <div
            className="today-progress-fill"
            style={{
              width: `${Math.round((new Date().getDate() / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()) * 100)}%`,
            }}
          />
        </div>
        {displayPlan.afterFixed > 0 ? (
          <>
            <div className="plan-grid" style={{ marginTop: '0.6rem' }}>
              <Donut segments={segments} centerTop="To save" centerBottom={inr(displayPlan.breakdown.save)} />
              <ul className="legend">
                {segments.map((s) => (
                  <li key={s.label}>
                    <i style={{ background: s.color }} />
                    <span>{s.label}</span>
                    <b className="mono">{inr(s.value)}</b>
                    <small className="muted">{Math.min(100, Math.max(0, Math.round((s.value / Math.max(displayPlan.income, 1)) * 100)))}%</small>
                  </li>
                ))}
              </ul>
            </div>

            <div className="actual-vs-budget">
              <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.95rem' }}>Spent so far</h3>
              <ul className="list" style={{ gap: '0.5rem' }}>
                <li className="list-item">
                  <span className="avatar">🍔</span>
                  <div className="grow">
                    <strong>Needs</strong>
                    <small className="muted">{inr(displayIns.spentOnNeeds)} of {inr(displayPlan.breakdown.needs)}</small>
                  </div>
                  <SpendBar spent={displayIns.spentOnNeeds} budget={displayPlan.breakdown.needs} color="var(--c-need)" />
                </li>
                <li className="list-item">
                  <span className="avatar">🎮</span>
                  <div className="grow">
                    <strong>Wants</strong>
                    <small className="muted">{inr(displayIns.spentOnWants)} of {inr(displayPlan.breakdown.wants)}</small>
                  </div>
                  <SpendBar spent={displayIns.spentOnWants} budget={displayPlan.breakdown.wants} color="var(--c-want)" />
                </li>
                <li className="list-item">
                  <span className="avatar">💰</span>
                  <div className="grow">
                    <strong>Save so far</strong>
                    <small className="muted">target {inr(displayPlan.breakdown.save)}</small>
                  </div>
                  <b className="mono" style={{ color: displayIns.actualSave >= displayPlan.breakdown.save ? 'var(--c-save)' : 'var(--warn)' }}>
                    {inr(displayIns.actualSave)}
                  </b>
                </li>
              </ul>
            </div>

            <div className="daily" style={{ marginTop: '0.8rem' }}>
              <span>Left to spend per day</span>
              <Money value={Math.max(0, Math.round(displayIns.dailyLeft))} className="big accent" />
              <small className="muted">
                {displayIns.daysRemaining} day{displayIns.daysRemaining === 1 ? '' : 's'} left · {inr(displayPlan.spentThisMonth ?? 0)} spent so far
              </small>
            </div>
            {!demoMode && (
              <p className="small" style={{ marginTop: '0.4rem' }}>
                <Link to="/plan">See line-by-line plan →</Link> · <Link to="/spending">Log today's spend →</Link>
              </p>
            )}
          </>
        ) : (
          <Empty emoji="⚠️" title="Your bills use all of your pay" text="Review which bills can be renegotiated, downgraded, or paused." />
        )}
      </Card>

      {/* The point of the app, in one tile. Same math on demo + real. */}
      <FiveYearProjection plan={displayPlan} demo={demoMode} />

      {!demoMode && (
        <p className="muted small center" style={{ margin: '0.6rem 0 0' }}>
          Want to edit pay, bills, or see personalised tips? <Link to="/plan">Open the plan →</Link>
        </p>
      )}
    </>
  );
}
