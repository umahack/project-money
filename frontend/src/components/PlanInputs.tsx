import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field, Money, burst } from './ui';
import { amountToInput, currentMonth, inr, monthLabel, parseAmount } from '../money';
import { errText, useToast } from '../state';
import type { Emi } from '../types';

export const EMI_CATEGORIES = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'] as const;
const CAT_ICON: Record<string, string> = { EMI: '🏦', Rent: '🏠', Utility: '💡', Insurance: '🛡️', Subscription: '📺', Other: '📌' };

/**
 * Pay + Monthly bills setup. Moved off the Home page so Home is a pure
 * overview and this is where users go to CHANGE their inputs. Mounted on
 * /plan so there's one place to adjust the money model.
 */
export function PlanInputs({ onChange }: { onChange?: () => void }) {
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
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      await api.post('/finance/salary', { amount: value });
      await load();
      onChange?.();
      toast('ok', 'Pay saved. Your plan is updated.');
      if (value > 0) burst(rect.left + rect.width / 2, rect.top + rect.height / 2);
    } catch (err) {
      toast('err', errText(err));
    } finally { setSaving(false); }
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
      onChange?.();
      toast('ok', 'Bill added');
    } catch (err) { toast('err', errText(err)); }
  }

  async function remove(id: number) {
    try {
      await api.del(`/finance/emis/${id}`);
      await load();
      onChange?.();
    } catch (err) { toast('err', errText(err)); }
  }

  const payAmount = parseAmount(salary) ?? 0;
  const emiTotal = emis.reduce((s, e) => s + e.amount, 0);
  const leftOver = Math.max(payAmount - emiTotal, 0);

  return (
    <div className="grid two gap-top">
      <Card>
        <h2 id="pay-form">💰 Monthly pay</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Take-home amount credited each month. Change anytime; the plan updates on your next refresh.</p>
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
        <h2 id="bills-form">📄 Monthly bills</h2>
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
  );
}
