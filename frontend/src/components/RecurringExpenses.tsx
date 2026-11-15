import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field } from './ui';
import { inr, parseAmount } from '../money';
import { errText, useToast } from '../state';

interface Recurring {
  id: number;
  label: string;
  amount: number;
  category: string;
  day_of_month: number;
  active: boolean;
  last_logged_month: string | null;
  created_at: string;
}

interface Response {
  categories: string[];
  recurring: Recurring[];
}

export function RecurringExpenses({ onChange }: { onChange?: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<Response | null>(null);
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Entertainment');
  const [day, setDay] = useState('1');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Response>('/finance/recurring'));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const amt = parseAmount(amount);
    const d = Number(day);
    if (!label.trim()) return toast('err', 'Give it a label');
    if (amt == null || amt < 0) return toast('err', 'Enter a valid amount');
    if (!Number.isInteger(d) || d < 1 || d > 31) return toast('err', 'Day of month must be 1–31');
    setBusy(true);
    try {
      await api.post('/finance/recurring', {
        label: label.trim(),
        amount: amt,
        category,
        dayOfMonth: d,
      });
      setLabel(''); setAmount('');
      await load();
      onChange?.();
      toast('ok', `Added recurring ${label} (day ${d})`);
    } catch (err) { toast('err', errText(err)); }
    finally { setBusy(false); }
  }

  async function toggle(r: Recurring) {
    setToggling(r.id);
    try {
      await api.patch(`/finance/recurring/${r.id}`, { active: !r.active });
      await load();
      onChange?.();
    } catch (err) { toast('err', errText(err)); }
    finally { setToggling(null); }
  }

  async function remove(id: number) {
    if (!confirm('Remove this recurring expense? Already-logged entries stay.')) return;
    setRemoving(id);
    try {
      await api.del(`/finance/recurring/${id}`);
      await load();
      onChange?.();
    } catch (err) { toast('err', errText(err)); }
    finally { setRemoving(null); }
  }

  return (
    <Card>
      <h2>🔁 Recurring expenses</h2>
      <p className="muted small">
        Netflix, rent, gym — anything that charges automatically each month. We'll log it to your month on the
        day you choose so you never forget.
      </p>

      {data && data.recurring.length > 0 && (
        <ul className="list">
          <AnimatePresence>
            {data.recurring.map((r) => (
              <motion.li
                key={r.id}
                className="list-item"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -16 }}
                layout
              >
                <span className="avatar">{r.active ? '🔁' : '⏸️'}</span>
                <div className="grow">
                  <strong>{r.label} <span className="pill info">{r.category}</span></strong>
                  <small className="muted">
                    {inr(r.amount)} on day {r.day_of_month}
                    {r.last_logged_month ? ` · last logged ${r.last_logged_month}` : ' · not logged yet'}
                  </small>
                </div>
                <button
                  className="btn sm ghost"
                  disabled={toggling === r.id}
                  onClick={() => void toggle(r)}
                  title={r.active ? 'Pause' : 'Resume'}
                >
                  {toggling === r.id ? '…' : r.active ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="btn sm ghost"
                  disabled={removing === r.id}
                  onClick={() => void remove(r.id)}
                >
                  {removing === r.id ? '…' : '✕'}
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <form onSubmit={create} className="stack-sm" style={{ marginTop: '0.6rem' }}>
        <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Netflix" /></Field>
        <div className="row-sm" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Field label="Amount"><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="499" maxLength={12} /></Field>
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {(data?.categories ?? ['Entertainment', 'Bills']).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Day of month">
            <input
              value={day}
              onChange={(e) => setDay(e.target.value.replace(/\D/g, '').slice(0, 2))}
              inputMode="numeric"
              placeholder="1"
              maxLength={2}
              style={{ width: 80 }}
            />
          </Field>
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Adding…' : '+ Add recurring'}
        </button>
      </form>
    </Card>
  );
}
