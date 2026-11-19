import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field, Money, ProgressBar } from './ui';
import { inr, parseAmount } from '../money';
import { errText, useToast } from '../state';

interface ExpenseRow {
  id: number;
  month: string;
  category: string;
  amount: number;
  note: string | null;
  spent_on: string | null;
  created_at: string;
}

interface ExpensesResponse {
  month: string;
  categories: string[];
  expenses: ExpenseRow[];
}

export function SpendingTracker({ disposable, onChange }: { disposable: number; onChange?: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<ExpensesResponse | null>(null);
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Food');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [editingBudget, setEditingBudget] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const [exp, bud] = await Promise.all([
        api.get<ExpensesResponse>('/finance/expenses'),
        api.get<{ budgets: Record<string, number> }>('/finance/budgets'),
      ]);
      setData(exp);
      setBudgets(bud.budgets);
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBudget(cat: string) {
    const n = parseAmount(budgetDraft);
    if (n == null || n < 0) return toast('err', 'Enter a valid amount');
    try {
      if (n === 0) {
        await api.del(`/finance/budgets/${cat}`);
      } else {
        await api.put(`/finance/budgets/${cat}`, { amount: n });
      }
      setEditingBudget(null);
      setBudgetDraft('');
      await load();
      toast('ok', n === 0 ? `Removed ${cat} budget` : `Set ${cat} budget to ${inr(n)}`);
    } catch (err) {
      toast('err', errText(err));
    }
  }

  const total = useMemo(() => data?.expenses.reduce((s, e) => s + e.amount, 0) ?? 0, [data]);
  const byCategory = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of data?.expenses ?? []) map[e.category] = (map[e.category] ?? 0) + e.amount;
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [data]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const n = parseAmount(amount);
    if (n == null || n <= 0) return toast('err', 'Enter a valid amount');
    // Optimistic: append a temp row and reset the form IMMEDIATELY so the
    // user sees instant feedback. Reconcile with the server's real id when
    // the response lands; roll back on error.
    const tempId = -Date.now();
    const noteVal = note.trim() || null;
    const today = new Date();
    const spentOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const monthKey = spentOn.slice(0, 7);
    const optimisticRow: ExpenseRow = {
      id: tempId,
      month: monthKey,
      category,
      amount: n,
      note: noteVal,
      spent_on: spentOn,
      created_at: new Date().toISOString(),
    };
    setData((d) => (d ? { ...d, expenses: [optimisticRow, ...d.expenses] } : d));
    setAmount('');
    setNote('');
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>('/finance/expenses', {
        amount: n, category, note: noteVal ?? undefined,
      });
      // Swap temp id for the real one so delete works.
      setData((d) => d ? ({
        ...d,
        expenses: d.expenses.map((row) => row.id === tempId ? { ...row, id: r.id } : row),
      }) : d);
      onChange?.();
      toast('ok', `Logged ${inr(n)} to ${category}`);
    } catch (err) {
      // Roll back.
      setData((d) => d ? ({ ...d, expenses: d.expenses.filter((row) => row.id !== tempId) }) : d);
      toast('err', errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    // Optimistic remove: drop immediately, re-insert on error.
    const removed = data?.expenses.find((r) => r.id === id);
    setData((d) => d ? ({ ...d, expenses: d.expenses.filter((r) => r.id !== id) }) : d);
    setRemoving(id);
    try {
      await api.del(`/finance/expenses/${id}`);
      onChange?.();
    } catch (err) {
      if (removed) setData((d) => d ? ({ ...d, expenses: [removed, ...d.expenses] }) : d);
      toast('err', errText(err));
    } finally {
      setRemoving(null);
    }
  }

  const pct = disposable > 0 ? Math.min(100, Math.round((total / disposable) * 100)) : 0;
  const over = disposable > 0 && total > disposable;

  return (
    <Card>
      <h2>📊 This month's spending</h2>

      <div className="stat-row">
        <div>
          <span className="muted">Spent so far</span>
          <Money value={total} className="big" />
        </div>
        <div>
          <span className="muted">Disposable (plan)</span>
          <Money value={disposable} className="big" />
        </div>
        <div>
          <span className="muted">Remaining</span>
          <Money value={Math.max(disposable - total, 0)} className={over ? 'big err-text' : 'big'} />
        </div>
      </div>

      {disposable > 0 && (
        <>
          <ProgressBar value={total} max={disposable} />
          <p className="small muted">
            {over
              ? `Over by ${inr(total - disposable)} this month — slow down on new spends.`
              : `${pct}% of this month's disposable used.`}
          </p>
        </>
      )}

      <form onSubmit={add} className="stack-sm" style={{ marginTop: '0.6rem' }}>
        <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Field label="Amount">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="e.g. 480"
              maxLength={12}
            />
          </Field>
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {(data?.categories ?? ['Food', 'Other']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Note (optional)">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={120}
            placeholder="Coffee with Priya"
          />
        </Field>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Logging…' : '+ Log expense'}
        </button>
      </form>

      {(byCategory.length > 0 || Object.keys(budgets).length > 0) && (
        <ul className="list" style={{ marginTop: '0.8rem' }}>
          {Array.from(new Set([...byCategory.map(([c]) => c), ...Object.keys(budgets)])).map((cat) => {
            const sum = byCategory.find(([c]) => c === cat)?.[1] ?? 0;
            const budget = budgets[cat] ?? 0;
            const over = budget > 0 && sum > budget;
            const isEditing = editingBudget === cat;
            return (
              <li key={cat} className="list-item" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
                <span className="pill info">{cat}</span>
                <div className="grow">
                  <span className="cat-budget-inline">
                    {budget > 0 ? (
                      <>
                        {inr(sum)} / {inr(budget)}
                        {over ? <span className="over">· over by {inr(sum - budget)}</span>
                          : <span className="under">· {inr(budget - sum)} left</span>}
                      </>
                    ) : (
                      <>No budget set</>
                    )}
                  </span>
                </div>
                {isEditing ? (
                  <div className="row-sm" style={{ gap: '0.3rem' }}>
                    <input
                      value={budgetDraft}
                      onChange={(e) => setBudgetDraft(e.target.value)}
                      inputMode="decimal"
                      placeholder="0 = remove"
                      style={{ width: 110 }}
                      autoFocus
                    />
                    <button className="btn sm" onClick={() => void saveBudget(cat)}>Save</button>
                    <button className="btn sm ghost" onClick={() => { setEditingBudget(null); setBudgetDraft(''); }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <b className="mono">{inr(sum)}</b>
                    <button
                      className="btn sm ghost"
                      onClick={() => { setEditingBudget(cat); setBudgetDraft(budget > 0 ? String(budget) : ''); }}
                      title={budget > 0 ? 'Edit budget' : 'Set budget'}
                      aria-label={budget > 0 ? 'Edit budget' : 'Set budget'}
                    >
                      {budget > 0 ? '✏️' : '➕'}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data?.expenses.length ? (
        <>
          <h3 style={{ marginTop: '1rem' }}>Recent entries</h3>
          <ul className="list">
            <AnimatePresence>
              {data.expenses.slice(0, 8).map((e) => (
                <motion.li
                  key={e.id}
                  className="list-item"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  layout
                >
                  <span className="avatar">{e.category.slice(0, 1)}</span>
                  <div className="grow">
                    <strong>{e.category}</strong>
                    <small className="muted">
                      {(e.spent_on ?? e.created_at.slice(0, 10))}
                      {e.note ? ` · ${e.note}` : ''}
                    </small>
                  </div>
                  <b className="mono">{inr(e.amount)}</b>
                  <button
                    className="btn sm ghost"
                    disabled={removing === e.id}
                    onClick={() => void remove(e.id)}
                    aria-label={`Delete ${e.category} ${inr(e.amount)}`}
                  >
                    {removing === e.id ? '…' : '✕'}
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {data.expenses.length > 8 && (
            <p className="small muted">+{data.expenses.length - 8} more this month.</p>
          )}
        </>
      ) : (
        <p className="muted small" style={{ marginTop: '0.6rem' }}>
          Log a few expenses to see your actuals against the plan.
        </p>
      )}
    </Card>
  );
}

