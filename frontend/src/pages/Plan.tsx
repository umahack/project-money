import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card } from '../components/ui';
import { ClarityPageHeader } from '../components/clarity/ClarityPageHeader';
import { RegionBoundary } from '../components/clarity/RegionBoundary';
import { ClassificationBadge } from '../components/clarity/labels';
import { INFORMATIONAL_DISCLAIMER } from '../components/clarity/format';
import { PlanChangeNotice, PlanOutcome } from '../components/plan/PlanOutcome';
import type { ConfirmedPlanChange } from '../components/plan/ClarityPlanInputs';
import { FALLBACK_ACTIONS, PAGE_DECISIONS } from '../clarity/actionContext';
import { useFinancialClarity } from '../clarity/FinancialClarityProvider';
import { selectCountedBills } from '../clarity/planInputs';
import { selectFinancialClarityRollout } from '../clarity/rollout';
import { useActionArrival } from '../clarity/useActionArrival';
import { useClaritySnapshotQuery } from '../clarity/useClaritySnapshot';
import { useHeaderAction } from '../clarity/useHeaderAction';
import { PlanInputs } from '../components/PlanInputs';
import { buildInsights, legacyDemoInsights } from '../insights';
import { currentMonth, inr, monthLabel } from '../money';
import { errText } from '../state';
import type { Emi, Plan as PlanData } from '../types';
import { DEMO_PLAN, DEMO_SAMPLE_NAME } from '../demoData';
import { readCachedPlan } from '../hooks/useCachedPlan';

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

/**
 * Plan. With `VITE_FINANCIAL_CLARITY_ENABLED` off this is the legacy page, unchanged.
 * With it on, the plan comes from the server's exact-month outcomes and pay and
 * bills save one record at a time without reloading the page.
 */
export function Plan() {
  return selectFinancialClarityRollout().enabled ? <ClarityPlan /> : <LegacyPlan />;
}

/**
 * ROLLBACK-ONLY: the flag-off Plan page. It keeps `window.location.reload()` after a
 * pay or bill save, browser math (`buildInsights`) and the session cache
 * (`useCachedPlan`), because rollback must restore the old page unchanged. Clarity
 * code must not use it, and no other file may call `location.reload`
 * (`src/clarity/rollbackBoundary.test.ts`).
 */
function LegacyPlan() {
  // Same hydration trick as Dashboard — read cache on mount so a tab reload
  // on Plan draws instantly instead of flashing Rohan while the server wakes.
  const cached = useMemo(() => readCachedPlan(), []);
  const [plan, setPlan] = useState<PlanData | null>(cached.plan);
  const [emis, setEmis] = useState<Emi[]>(cached.emis ?? []);
  const [err, setErr] = useState('');
  const [loaded, setLoaded] = useState<boolean>(cached.plan !== null);
  // Scrolls to and focuses the pay or bills form named by the link that opened this page.
  useActionArrival('plan');
  const rankedAction = useHeaderAction('plan');

  useEffect(() => {
    (async () => {
      try {
        const [p, e] = await Promise.all([api.get<PlanData>('/finance/plan'), api.get<{ emis: Emi[] }>('/finance/emis')]);
        setPlan(p);
        setEmis(e.emis);
        setLoaded(true);
      } catch (e) {
        setErr(errText(e));
        setLoaded(true);
      }
    })();
  }, []);

  const ins = useMemo(() => (plan ? buildInsights(plan, emis) : null), [plan, emis]);

  if (err) return <Card><p className="form-error">{err}</p></Card>;

  // Quiet loading state before the first server response. Avoids showing
  // "Rohan's month" to returning users whose cache was just cleared.
  if (!loaded && !plan) {
    return (
      <ClarityPageHeader
        legacy={{ title: 'Plan your month 🧾', sub: 'Loading…' }}
        title="Plan"
        decision={PAGE_DECISIONS.plan}
        fallbackAction={FALLBACK_ACTIONS.planSetPay}
      />
    );
  }

  // Demo mode only kicks in once the server has confirmed no pay is set.
  const demoMode = loaded && (!plan || plan.income <= 0);
  const displayPlan: PlanData = demoMode ? DEMO_PLAN : plan!;
  const displayIns = demoMode ? legacyDemoInsights() : ins!;
  const { needs, wants, save } = displayPlan.breakdown;

  return (
    <>
      <ClarityPageHeader
        legacy={{
          title: demoMode ? 'Plan your month 🧾' : 'Your month, line by line 🧾',
          sub: demoMode
            ? `Sample plan built from ${DEMO_SAMPLE_NAME}'s ₹${DEMO_PLAN.income.toLocaleString('en-IN')} month. Set your pay to see yours.`
            : `Based on ${inr(displayPlan.income)} a month, after ${inr(displayPlan.emiTotal)} in mandatory payments.`,
        }}
        title="Plan"
        decision={PAGE_DECISIONS.plan}
        action={rankedAction}
        fallbackAction={demoMode ? FALLBACK_ACTIONS.planSetPay : emis.length === 0 ? FALLBACK_ACTIONS.planAddBills : FALLBACK_ACTIONS.planCorrect}
        right={demoMode ? <span className="pill info">Sample plan</span> : undefined}
      />

      {/* Pay + bills inputs live here. In demo mode they are the primary CTA
          — fill pay and the whole page re-renders with real numbers. */}
      <PlanInputs onChange={() => window.location.reload()} />

      <Card tilt>
        <div className="grid four">
          <Total label="Income" value={inr(displayPlan.income)} tone="ok" />
          <Total label="Fixed / EMIs" value={inr(displayPlan.emiTotal)} tone="bad" />
          <Total label="Disposable" value={inr(displayPlan.afterFixed)} tone="warn" />
          <Total label="Emergency fund target" value={inr(displayIns.emergencyTarget)} tone="info" />
        </div>
      </Card>

      <div className="stack gap-top">
        <Section title="What to spend on" sub="Essentials · 50% of disposable" subtotal={needs} items={NEEDS} color="var(--c-need)" />
        <Section title="What you can enjoy" sub="Lifestyle · 30% of disposable" subtotal={wants} items={WANTS} color="var(--c-want)" />
        <Section title="What to save and invest" sub="20% of disposable" subtotal={save} items={SAVINGS} color="var(--c-save)" />

        <Card>
          <div className="row between wrap" style={{ gap: '0.4rem' }}>
            <h2 style={{ margin: 0 }}>🧠 Smart recommendations</h2>
            {demoMode && <span className="pill info">Sample</span>}
          </div>
          {demoMode && (
            <p className="muted small" style={{ marginTop: '0.3rem' }}>
              These apply to {DEMO_SAMPLE_NAME}'s sample month. Enter your pay above
              to get recommendations based on your own numbers.
            </p>
          )}
          <ul className="recs">
            {displayIns.recs.map((r, i) => (
              <li key={r.title + i} className={`rec ${r.level}`}>
                <div>
                  <strong>{demoMode ? `Sample · ${r.title}` : r.title}</strong>
                  <p>{r.text}</p>
                </div>
              </li>
            ))}
            {!demoMode && (
              <li className="rec info"><div><strong>Review every quarter</strong><p>Rebalance this plan every three months, or after any raise or EMI change.</p></div></li>
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}

/** Mutation scopes that change the monthly plan: salary, existing bills, and the add-bill form. */
const PLAN_SCOPE = /^(salary|bill|new-bill):/;

function ClarityPlan() {
  const month = currentMonth();
  const monthName = monthLabel(month);
  // Scrolls to and focuses the pay or bills form named by the link that opened this page.
  useActionArrival('plan');
  const rankedAction = useHeaderAction('plan');
  const query = useClaritySnapshotQuery(month);
  const view = useFinancialClarity(month);
  // Newest confirmed snapshot with pending patches. The query covers the moment between a response and the store install.
  const snapshot = view.snapshot ?? query.data;
  const [change, setChange] = useState<ConfirmedPlanChange | null>(null);
  const [retrying, setRetrying] = useState(false);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const { refetch } = query;

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  // Recalculation re-reads the confirmed snapshot. Confirmed pay and bills stay in their inputs.
  const recalculate = useCallback(async () => {
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  }, [refetch]);

  const plan = snapshot?.outcomes.monthlyPlan;
  const updating = view.pendingMutations.some((mutation) => PLAN_SCOPE.test(mutation.scopeKey));
  const salaryMissing = plan?.status === 'missing_input' && !!plan.missing?.some((item) => item.input === 'salary');
  const billCount = selectCountedBills(snapshot, month).length;
  const fallbackAction = !snapshot || salaryMissing
    ? FALLBACK_ACTIONS.planSetPay
    : billCount === 0 ? FALLBACK_ACTIONS.planAddBills : FALLBACK_ACTIONS.planCorrect;
  const value = plan?.status === 'available' ? plan.value : undefined;
  const error = query.isError ? query.error : undefined;

  return (
    <>
      <ClarityPageHeader
        legacy={{ title: 'Plan' }}
        title="Plan"
        decision={PAGE_DECISIONS.plan}
        action={rankedAction}
        fallbackAction={fallbackAction}
        right={<span className="pill info">{monthName}</span>}
      />

      <div ref={outcomeRef} tabIndex={-1}>
        <RegionBoundary
          regionKey="monthly-plan"
          label="Monthly plan"
          hasData={!!snapshot}
          loading={query.isFetching}
          error={error}
          onRetry={refresh}
          minHeight={240}
        >
          {snapshot && (
            <PlanOutcome snapshot={snapshot} month={month} updating={updating} retrying={retrying} onRetry={recalculate} />
          )}
        </RegionBoundary>
        {change && (
          <PlanChangeNotice
            change={change}
            onDismiss={() => {
              setChange(null);
              outcomeRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
      {!snapshot && !error && (
        <p className="muted small center" style={{ marginTop: '0.8rem' }} aria-live="polite">
          If this takes a few seconds, the free API host is waking up.
        </p>
      )}

      {/* The pay and bills forms follow the outcome. Each purpose explanation and preview sits above its input. */}
      <RegionBoundary
        regionKey="plan-inputs"
        label="Pay and bills"
        hasData={!!snapshot}
        loading={false}
        error={error}
        onRetry={refresh}
        minHeight={200}
      >
        {snapshot && (
          <PlanInputs month={month} snapshot={snapshot} onConfirmed={setChange} onRefresh={refresh} />
        )}
      </RegionBoundary>

      {value && (
        <div className="stack gap-top">
          <p className="small muted">
            <ClassificationBadge classification="recommendation" /> The lines below are suggested guideline shares of each budget. {INFORMATIONAL_DISCLAIMER}
          </p>
          <Section title="What to spend on" sub={`Essentials · 50% of disposable for ${monthName}`} subtotal={value.needsBudget.amountMinor / 100} items={NEEDS} color="var(--c-need)" amounts={false} />
          <Section title="What you can enjoy" sub={`Lifestyle · 30% of disposable for ${monthName}`} subtotal={value.wantsBudget.amountMinor / 100} items={WANTS} color="var(--c-want)" amounts={false} />
          <Section title="What to save and invest" sub={`20% of disposable for ${monthName}`} subtotal={value.savingsTarget.amountMinor / 100} items={SAVINGS} color="var(--c-save)" amounts={false} />
        </div>
      )}
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

/**
 * One budget bucket split into suggested lines. With `amounts` off (the clarity
 * branch) each line shows its fixed guideline share instead of a rupee amount, so
 * no financial value is calculated in the browser.
 */
function Section({ title, sub, subtotal, items, color, amounts = true }: {
  title: string;
  sub: string;
  subtotal: number;
  items: Line[];
  color: string;
  amounts?: boolean;
}) {
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
                <b className="mono" style={{ color }}>{amounts ? inr(subtotal * share) : `${Math.round(share * 100)}% of this budget`}</b>
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
