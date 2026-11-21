import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field } from './ui';
import { currentMonth, inr, parseAmount } from '../money';
import { errText, useToast } from '../state';
import { selectFinancialClarityRollout } from '../clarity/rollout';
import { ClaritySavingsGoals, type ClaritySavingsGoalsProps } from './goals/ClaritySavingsGoals';

interface Goal {
  id: number;
  name: string;
  target_amount: number;
  saved_amount: number;
  target_date: string | null;
  created_at: string;
  updated_at: string;
}

const NO_ARRIVAL = { action: null, key: '' } as const;
const NOTHING = () => undefined;

/**
 * Savings goals. With the rollout flag off this is the original component,
 * unchanged. With it on, the Goals page passes the confirmed snapshot and every
 * create, correction, contribution, revision, and delete is its own scoped
 * mutation against the server's canonical goal outcomes.
 */
export function SavingsGoals(props: Partial<ClaritySavingsGoalsProps> = {}) {
  if (selectFinancialClarityRollout().enabled) {
    return (
      <ClaritySavingsGoals
        month={props.month ?? currentMonth()}
        snapshot={props.snapshot}
        snapshotLoading={props.snapshotLoading ?? false}
        snapshotError={props.snapshotError}
        arrival={props.arrival ?? NO_ARRIVAL}
        onRefresh={props.onRefresh ?? NOTHING}
        onRecalculate={props.onRecalculate ?? NOTHING}
        recalculating={props.recalculating ?? false}
      />
    );
  }
  return <LegacySavingsGoals />;
}

// ROLLBACK-ONLY: the flag-off goals list. Clarity code must not use it (src/clarity/rollbackBoundary.test.ts).
function LegacySavingsGoals() {
  const { toast } = useToast();
  const [items, setItems] = useState<Goal[] | null>(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [saved, setSaved] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [contributeFor, setContributeFor] = useState<number | null>(null);
  const [contribution, setContribution] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ goals: Goal[] }>('/finance/goals');
      setItems(r.goals);
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const tgt = parseAmount(target);
    const svd = saved.trim() ? parseAmount(saved) : 0;
    if (!name.trim()) return toast('err', 'Give the goal a name');
    if (tgt == null || tgt <= 0) return toast('err', 'Target amount must be greater than 0');
    if (svd != null && svd < 0) return toast('err', 'Saved amount must be ≥ 0');
    setBusy(true);
    try {
      await api.post('/finance/goals', {
        name: name.trim(),
        targetAmount: tgt,
        savedAmount: svd ?? 0,
        targetDate: date || null,
      });
      setName(''); setTarget(''); setSaved(''); setDate('');
      await load();
      toast('ok', 'Goal created');
    } catch (err) { toast('err', errText(err)); }
    finally { setBusy(false); }
  }

  async function contribute(goal: Goal) {
    const amt = parseAmount(contribution);
    if (amt == null || amt === 0) return toast('err', 'Enter an amount');
    try {
      await api.patch(`/finance/goals/${goal.id}`, { addToSaved: amt });
      setContributeFor(null);
      setContribution('');
      await load();
      toast('ok', `Added ${inr(amt)} to ${goal.name}`);
    } catch (err) { toast('err', errText(err)); }
  }

  async function remove(id: number) {
    if (!confirm('Delete this goal?')) return;
    try {
      await api.del(`/finance/goals/${id}`);
      await load();
    } catch (err) { toast('err', errText(err)); }
  }

  return (
    <Card>
      <h2>🎯 Savings goals</h2>
      <p className="muted small">Set a target amount and watch your progress each time you add to it.</p>

      {items && items.length > 0 && (
        <ul id="goals-list" tabIndex={-1} className="list">
          <AnimatePresence>
            {items.map((g) => {
              const pct = g.target_amount > 0 ? Math.min(100, Math.round((g.saved_amount / g.target_amount) * 100)) : 0;
              const done = g.saved_amount >= g.target_amount;
              return (
                <motion.li
                  key={g.id}
                  id={`goal-${g.id}`}
                  tabIndex={-1}
                  className="list-item"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  layout
                  style={{ flexDirection: 'column', alignItems: 'stretch' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span className="avatar">{done ? '✅' : '🎯'}</span>
                    <div className="grow">
                      <strong>{g.name}</strong>
                      <small className="muted">
                        {inr(g.saved_amount)} of {inr(g.target_amount)} · {pct}%
                        {g.target_date ? ` · by ${g.target_date}` : ''}
                      </small>
                    </div>
                    <button className="btn sm" onClick={() => { setContributeFor(contributeFor === g.id ? null : g.id); setContribution(''); }}>
                      + Add
                    </button>
                    <button className="btn sm ghost" onClick={() => void remove(g.id)}>✕</button>
                  </div>
                  <div className="goal-progress-track"><div className="goal-progress-fill" style={{ width: `${pct}%` }} /></div>
                  {contributeFor === g.id && (
                    <form
                      onSubmit={(e) => { e.preventDefault(); void contribute(g); }}
                      className="row-sm"
                      style={{ gap: '0.4rem', marginTop: '0.5rem' }}
                    >
                      <input
                        value={contribution}
                        onChange={(e) => setContribution(e.target.value)}
                        inputMode="decimal"
                        placeholder="e.g. 500 or -200 to withdraw"
                        maxLength={12}
                        autoFocus
                      />
                      <button className="btn sm" type="submit">Save</button>
                      <button type="button" className="btn sm ghost" onClick={() => setContributeFor(null)}>Cancel</button>
                    </form>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      <form id="goal-form" tabIndex={-1} onSubmit={create} className="stack-sm" style={{ marginTop: '0.6rem' }}>
        <Field label="Goal name"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Laptop upgrade" /></Field>
        <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Field label="Target amount"><input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="60000" maxLength={12} /></Field>
          <Field label="Saved so far (optional)"><input value={saved} onChange={(e) => setSaved(e.target.value)} inputMode="decimal" placeholder="0" maxLength={12} /></Field>
          <Field label="Target date (optional)"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Add goal'}</button>
      </form>
    </Card>
  );
}
