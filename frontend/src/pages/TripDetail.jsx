import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api/client.js';

const money = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

export default function TripDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [m, setM] = useState({ name: '', email: '' });
  const [ex, setEx] = useState({ payer: '', description: '', amount: '', shares: {} });

  async function load() {
    const d = await api(`/trips/${id}`);
    setData(d);
    const shares = {};
    for (const mem of d.members) shares[mem.name] = ex.shares[mem.name] ?? 1;
    setEx((e) => ({ ...e, shares, payer: e.payer || d.members[0]?.name || '' }));
  }
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [id]);

  async function addMember(e) {
    e.preventDefault();
    if (!m.name.trim()) return;
    try {
      await api(`/trips/${id}/members`, { method: 'POST', body: { name: m.name.trim(), email: m.email || undefined } });
      setM({ name: '', email: '' });
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function addExpense(e) {
    e.preventDefault();
    const amount = Number(ex.amount);
    if (!ex.payer || !ex.description.trim() || !Number.isFinite(amount) || amount <= 0)
      return setErr('Fill payer, description, and amount');
    const split = Object.entries(ex.shares)
      .filter(([, v]) => Number(v) > 0)
      .map(([name, v]) => ({ name, share: Number(v) }));
    if (!split.length) return setErr('Pick at least one person in split');
    try {
      await api(`/trips/${id}/expenses`, { method: 'POST', body: { payer: ex.payer, description: ex.description.trim(), amount, split } });
      setEx((p) => ({ ...p, description: '', amount: '' }));
      await load();
    } catch (e) { setErr(e.message); }
  }

  if (!data) return <div className="text-white/60">Loading…</div>;
  const { trip, members, expenses, settlement } = data;
  const spent = expenses.reduce((a, b) => a + b.amount, 0);
  const left = Math.max(trip.budget - spent, 0);

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-2xl font-bold">{trip.name}</div>
            <div className="text-white/60">{trip.destination || '—'} · {trip.start_date || '—'} → {trip.end_date || '—'}</div>
          </div>
          <div className="flex gap-2">
            <span className="pill">Budget {money(trip.budget)}</span>
            <span className="pill">Spent {money(spent)}</span>
            <span className="pill">Left {money(left)}</span>
          </div>
        </div>
        <div className="h-2 bg-white/10 rounded-full mt-4 overflow-hidden">
          <motion.div
            initial={{ width: 0 }} animate={{ width: `${Math.min(100, (spent / Math.max(trip.budget, 1)) * 100)}%` }}
            className="h-full bg-gradient-to-r from-mint via-orchid to-amber"
          />
        </div>
      </motion.div>

      {err && <div className="text-rose">{err}</div>}

      <div className="grid md:grid-cols-2 gap-6">
        <motion.div className="card" whileHover={{ y: -2 }}>
          <h2 className="font-semibold mb-3">Invite friends</h2>
          <form onSubmit={addMember} className="flex flex-wrap gap-2">
            <input className="input flex-1 min-w-[160px]" placeholder="Name"
              value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} maxLength={40} />
            <input className="input flex-1 min-w-[200px]" type="email" placeholder="Email (optional)"
              value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} />
            <button className="btn-primary">Add</button>
          </form>
          <ul className="mt-3 flex flex-wrap gap-2">
            <AnimatePresence>
              {members.map((mem) => (
                <motion.li key={mem.id}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                  className="pill"
                >
                  {mem.name}{mem.email ? ` · ${mem.email}` : ''}
                </motion.li>
              ))}
            </AnimatePresence>
            {!members.length && <li className="text-white/50 text-sm">No one yet. Invite your crew.</li>}
          </ul>
        </motion.div>

        <motion.div className="card" whileHover={{ y: -2 }}>
          <h2 className="font-semibold mb-3">Add shared expense</h2>
          <form onSubmit={addExpense} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <select className="input" value={ex.payer} onChange={(e) => setEx({ ...ex, payer: e.target.value })}>
                <option value="" disabled>Payer</option>
                {members.map((mem) => <option key={mem.id} value={mem.name}>{mem.name}</option>)}
              </select>
              <input className="input" inputMode="decimal" placeholder="Amount"
                value={ex.amount} onChange={(e) => setEx({ ...ex, amount: e.target.value })} />
            </div>
            <input className="input" placeholder="Description" maxLength={100}
              value={ex.description} onChange={(e) => setEx({ ...ex, description: e.target.value })} />
            <div className="text-sm text-white/60">Share weights (0 excludes)</div>
            <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto scrollbar">
              {members.map((mem) => (
                <label key={mem.id} className="flex items-center justify-between gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-1.5">
                  <span>{mem.name}</span>
                  <input className="w-16 bg-transparent text-right focus:outline-none"
                    inputMode="decimal"
                    value={ex.shares[mem.name] ?? 1}
                    onChange={(e) => setEx({ ...ex, shares: { ...ex.shares, [mem.name]: e.target.value } })} />
                </label>
              ))}
            </div>
            <button className="btn-primary w-full" disabled={!members.length}>Add expense</button>
          </form>
        </motion.div>
      </div>

      <motion.div className="card" whileHover={{ y: -2 }}>
        <h2 className="font-semibold mb-3">Settle up</h2>
        {settlement.transactions.length ? (
          <ul className="space-y-2">
            {settlement.transactions.map((t, i) => (
              <motion.li key={i}
                initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-3 py-2"
              >
                <div><span className="text-rose">{t.from}</span> pays <span className="text-mint">{t.to}</span></div>
                <div className="font-semibold">{money(t.amount)}</div>
              </motion.li>
            ))}
          </ul>
        ) : <div className="text-white/50">All square 🎉</div>}
      </motion.div>

      <motion.div className="card" whileHover={{ y: -2 }}>
        <h2 className="font-semibold mb-3">Expenses</h2>
        <ul className="space-y-2">
          {expenses.map((e) => (
            <li key={e.id} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="font-medium">{e.description}</div>
                <div className="font-semibold">{money(e.amount)}</div>
              </div>
              <div className="text-xs text-white/60">
                Paid by {e.payer} · split: {e.split.map((s) => `${s.name}×${s.share}`).join(', ')}
              </div>
            </li>
          ))}
          {!expenses.length && <li className="text-white/50">No expenses yet.</li>}
        </ul>
      </motion.div>
    </div>
  );
}
