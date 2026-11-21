import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field, Money, burst } from './ui';
import { amountToInput, currentMonth, inr, monthLabel, parseAmount } from '../money';
import { errText, useToast } from '../state';
import type { Emi } from '../types';
import { selectFinancialClarityRollout } from '../clarity/rollout';
import { ClarityPlanInputs, type ClarityPlanInputsProps } from './plan/ClarityPlanInputs';

export const EMI_CATEGORIES = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'] as const;
const CAT_ICON: Record<string, string> = { EMI: '🏦', Rent: '🏠', Utility: '💡', Insurance: '🛡️', Subscription: '📺', Other: '📌' };

export interface PlanInputsProps {
  /** Legacy only: called after a change. The legacy Plan page reloads the document here. */
  onChange?: () => void;
  /** Clarity only: the exact month the inputs apply to. */
  month?: string;
  /** Clarity only: newest confirmed snapshot with pending patches applied. */
  snapshot?: ClarityPlanInputsProps['snapshot'];
  /** Clarity only: called after each confirmed salary or bill change. */
  onConfirmed?: ClarityPlanInputsProps['onConfirmed'];
  /** Clarity only: re-reads the confirmed snapshot. */
  onRefresh?: ClarityPlanInputsProps['onRefresh'];
}

/**
 * Pay + Monthly bills setup, where users CHANGE their inputs. With the rollout
 * flag off this is the original component, unchanged. With it on, each salary and
 * bill is its own scoped mutation: no reload, no component-wide saving state.
 */
export function PlanInputs({ onChange, month, snapshot, onConfirmed, onRefresh }: PlanInputsProps) {
  if (selectFinancialClarityRollout().enabled) {
    return (
      <ClarityPlanInputs
        month={month ?? currentMonth()}
        snapshot={snapshot}
        onConfirmed={onConfirmed}
        onRefresh={onRefresh}
      />
    );
  }
  return <LegacyPlanInputs onChange={onChange} />;
}

/**
 * Pay + Monthly bills setup. Moved off the Home page so Home is a pure
 * overview and this is where users go to CHANGE their inputs. Mounted on
 * /plan so there's one place to adjust the money model.
 */
// ROLLBACK-ONLY: the flag-off pay and bills form. Clarity code must not use it (src/clarity/rollbackBoundary.test.ts).
function LegacyPlanInputs({ onChange }: { onChange?: () => void }) {
  const { toast } = useToast();
  const [salaryMonth, setSalaryMonth] = useState<string | null>(null);
  const [salary, setSalary] = useState('');
  const [emis, setEmis] = useState<Emi[]>([]);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>('EMI');
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        api.get<{ salary: { month: string; amount: number } | null }>('/finance/salary'),
        api.get<{ emis: Emi[] }>('/finance/emis'),
      ]);
      setSalary(amountToInput(s.salary?.amount));
      setSalaryMonth(s.salary?.month ?? null);
      setEmis(e.emis);
    } catch (err) {
      toast('err', errText(err));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const stale = salaryMonth && salaryMonth !== currentMonth();

  async function saveSalary(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = parseAmount(salary || '0');
    if (value === null) return toast('err', 'Enter a valid amount, e.g. 75000 or 75,000.50');
    setSaving(true);
    const prevMonth = salaryMonth;
    // Optimistic: update the month pill to the current month immediately.
    setSalaryMonth(currentMonth());
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      await api.post('/finance/salary', { amount: value });
      onChange?.();
      toast('ok', 'Pay saved. Your plan is updated.');
      if (value > 0) burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    } catch (err) {
      setSalaryMonth(prevMonth);  // roll back
      toast('err', errText(err));
    } finally { setSaving(false); }
  }

  async function addEmi(e: FormEvent) {
    e.preventDefault();
    const value = parseAmount(amount);
    if (!label.trim()) return toast('err', 'Give this payment a name');
    if (value === null || value <= 0) return toast('err', 'Enter a valid monthly amount');
    const draftLabel = label.trim();
    const draftCat = category;
    // Optimistic: append a temp row, clear form instantly.
    const tempId = -Date.now();
    setEmis((xs) => [{ id: tempId, label: draftLabel, amount: value, category: draftCat }, ...xs]);
    setLabel('');
    setAmount('');
    try {
      const r = await api.post<{ id: number }>('/finance/emis', { label: draftLabel, amount: value, category: draftCat });
      // Swap temp id for the real server id so delete works.
      setEmis((xs) => xs.map((e2) => e2.id === tempId ? { ...e2, id: r.id } : e2));
      onChange?.();
      toast('ok', 'Bill added');
    } catch (err) {
      setEmis((xs) => xs.filter((e2) => e2.id !== tempId));  // roll back
      toast('err', errText(err));
    }
  }

  async function remove(id: number) {
    const removed = emis.find((e2) => e2.id === id);
    setEmis((xs) => xs.filter((e2) => e2.id !== id));
    try {
      await api.del(`/finance/emis/${id}`);
      onChange?.();
    } catch (err) {
      if (removed) setEmis((xs) => [removed, ...xs]);
      toast('err', errText(err));
    }
  }

  // Inline edit state: which emi id is in edit mode, and its draft fields.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editCategory, setEditCategory] = useState<string>('EMI');

  function startEdit(c: Emi) {
    setEditingId(c.id);
    setEditLabel(c.label);
    setEditAmount(amountToInput(c.amount));
    setEditCategory(c.category);
  }
  function cancelEdit() { setEditingId(null); }
  async function saveEdit(id: number) {
    const value = parseAmount(editAmount);
    if (!editLabel.trim()) return toast('err', 'Name required');
    if (value === null || value < 0) return toast('err', 'Invalid amount');
    const prev = emis.find((e) => e.id === id);
    const nextLabel = editLabel.trim();
    const nextAmt = value;
    const nextCat = editCategory;
    // Optimistic: patch the local row instantly, close the edit UI.
    setEmis((xs) => xs.map((e) => e.id === id ? { ...e, label: nextLabel, amount: nextAmt, category: nextCat } : e));
    setEditingId(null);
    try {
      await api.patch(`/finance/emis/${id}`, { label: nextLabel, amount: nextAmt, category: nextCat });
      onChange?.();
      toast('ok', 'Bill updated');
    } catch (err) {
      if (prev) setEmis((xs) => xs.map((e) => e.id === id ? prev : e));
      toast('err', errText(err));
    }
  }

  const payAmount = parseAmount(salary) ?? 0;
  const emiTotal = emis.reduce((s, e) => s + e.amount, 0);
  const leftOver = Math.max(payAmount - emiTotal, 0);

  return (
    <div className="grid two gap-top">
      <Card>
        <h2 id="pay-form" tabIndex={-1}>💰 Monthly pay</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          <strong>Why we ask:</strong> we subtract your bills from this, then split what's left
          into Needs 50 / Wants 30 / Save 20 — the daily-spend number is derived from here.
          Just the take-home amount credited each month; no tax math needed.
        </p>
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
          <div><span className="muted">Pay</span><Money value={payAmount} className="big" /></div>
          <div><span className="muted">Bills</span><Money value={emiTotal} className="big" /></div>
          <div><span className="muted">Left over</span><Money value={leftOver} className="big" /></div>
        </div>
      </Card>

      <Card>
        <h2 id="bills-form" tabIndex={-1}>📄 Monthly bills <small className="muted" style={{ fontWeight: 400 }}>(optional)</small></h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          <strong>Why we ask:</strong> these come out of your pay before anything else, so we
          remove them first — otherwise the plan would suggest spending money you don't actually
          have. Add rent, EMIs, Netflix, insurance, gym. Skip entirely if you don't have any.
        </p>
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
              <motion.li
                key={c.id}
                layout
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 40 }}
                className="list-item hoverable"
              >
                {editingId === c.id ? (
                  <>
                    <span className="avatar">✏️</span>
                    <div className="grow" style={{ display: 'grid', gap: '0.3rem' }}>
                      <input
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        maxLength={60}
                        placeholder="Name"
                      />
                      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                        <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)}>
                          {EMI_CATEGORIES.map((cat) => <option key={cat}>{cat}</option>)}
                        </select>
                        <input
                          value={editAmount}
                          onChange={(e) => setEditAmount(e.target.value)}
                          inputMode="decimal"
                          placeholder="₹/month"
                          maxLength={16}
                          style={{ flex: 1, minWidth: 100 }}
                        />
                      </div>
                    </div>
                    <button className="btn primary sm" onClick={() => void saveEdit(c.id)}>Save</button>
                    <button className="btn ghost sm" onClick={cancelEdit}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="avatar">{CAT_ICON[c.category] ?? '📌'}</span>
                    <div className="grow">
                      <strong>{c.label}</strong>
                      <small className="muted">{c.category}</small>
                    </div>
                    <b className="mono">{inr(c.amount)}</b>
                    <button className="icon-btn" title={`Edit ${c.label}`} aria-label={`Edit ${c.label}`} onClick={() => startEdit(c)}>✏️</button>
                    <button className="icon-btn danger" aria-label={`Delete ${c.label}`} onClick={() => void remove(c.id)}>🗑️</button>
                  </>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </Card>
    </div>
  );
}
