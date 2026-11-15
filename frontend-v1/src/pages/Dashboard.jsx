import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { api, getUser } from '../api/client.js';
import Toast from '../components/Toast.jsx';

const CATS = ['EMI', 'Rent', 'Utility', 'Insurance', 'Subscription', 'Other'];
const COLORS = ['#4ade80', '#a78bfa', '#fbbf24', '#fb7185', '#60a5fa', '#f472b6'];

function money(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

export default function Dashboard() {
  const user = getUser();
  const [salary, setSalary] = useState('');
  const [plan, setPlan] = useState(null);
  const [emis, setEmis] = useState([]);
  const [em, setEm] = useState({ label: '', amount: '', category: 'EMI' });
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');

  async function load() {
    const [s, e, p] = await Promise.all([
      api('/finance/salary'),
      api('/finance/emis'),
      api('/finance/plan'),
    ]);
    if (s.salary) setSalary(s.salary.amount);
    setEmis(e.emis);
    setPlan(p);
  }
  useEffect(() => { load().catch((e) => setErr(e.message)); }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem('pm_feedback_thanks') === '1') {
        setToast(`Welcome back, ${user?.name?.split(' ')[0] || 'friend'} — thanks for the feedback last time!`);
        localStorage.removeItem('pm_feedback_thanks');
      }
    } catch {}
  }, []);

  async function saveSalary(e) {
    e.preventDefault();
    const amount = Number(salary);
    if (!Number.isFinite(amount) || amount < 0) return setErr('Enter a valid amount');
    await api('/finance/salary', { method: 'POST', body: { amount } });
    await load();
  }

  async function addEmi(e) {
    e.preventDefault();
    const amount = Number(em.amount);
    if (!em.label.trim() || !Number.isFinite(amount) || amount <= 0) return setErr('Fill all EMI fields');
    await api('/finance/emis', { method: 'POST', body: { label: em.label.trim(), amount, category: em.category } });
    setEm({ label: '', amount: '', category: 'EMI' });
    await load();
  }

  async function delEmi(id) {
    await api(`/finance/emis/${id}`, { method: 'DELETE' });
    await load();
  }

  const pieData = plan ? [
    { name: 'Needs (50%)', value: plan.breakdown.needs },
    { name: 'Wants (30%)', value: plan.breakdown.wants },
    { name: 'Save (20%)', value: plan.breakdown.save },
    { name: 'Fixed/EMI', value: plan.emiTotal },
  ].filter((x) => x.value > 0) : [];

  return (
    <div className="space-y-6">
      <Toast message={toast} onClose={() => setToast('')} />
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        className="card flex flex-wrap items-center justify-between gap-4"
      >
        <div>
          <div className="text-sm text-white/60">Hey {user?.name?.split(' ')[0] || 'there'} 👋</div>
          <div className="text-2xl font-bold">Your money plan</div>
        </div>
        <form onSubmit={saveSalary} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">Credited monthly salary</label>
            <input className="input w-64" inputMode="decimal" placeholder="e.g. 80000"
              value={salary} onChange={(e) => setSalary(e.target.value)} />
          </div>
          <button className="btn-primary">Update</button>
        </form>
      </motion.div>

      {err && <div className="text-rose">{err}</div>}

      <div className="grid md:grid-cols-3 gap-6">
        <Stat label="Income" value={money(plan?.income)} tint="from-mint/40" />
        <Stat label="Fixed/EMIs" value={money(plan?.emiTotal)} tint="from-rose/40" />
        <Stat label="Disposable" value={money(plan?.afterFixed)} tint="from-orchid/40" />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <motion.div className="card" whileHover={{ y: -2 }}>
          <h2 className="font-semibold mb-3">Allocation (50 / 30 / 20)</h2>
          <div className="h-64">
            {pieData.length ? (
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={3}>
                    {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: '#0a0f1c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12 }}
                    formatter={(v) => money(v)} />
                  <Legend wrapperStyle={{ color: 'white' }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <div className="grid h-full place-items-center text-white/50">Add salary to see allocation.</div>}
          </div>
          {plan && (
            <ul className="text-sm space-y-1 mt-3 text-white/80">
              <li>Needs: {money(plan.breakdown.needs)} · Wants: {money(plan.breakdown.wants)} · Save: {money(plan.breakdown.save)}</li>
            </ul>
          )}
        </motion.div>

        <motion.div className="card" whileHover={{ y: -2 }}>
          <h2 className="font-semibold mb-3">Mandatory monthly payments</h2>
          <form onSubmit={addEmi} className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <input className="input col-span-2" placeholder="Label (e.g. Home loan)"
              value={em.label} onChange={(e) => setEm({ ...em, label: e.target.value })} maxLength={60} />
            <input className="input" inputMode="decimal" placeholder="Amount"
              value={em.amount} onChange={(e) => setEm({ ...em, amount: e.target.value })} />
            <select className="input" value={em.category} onChange={(e) => setEm({ ...em, category: e.target.value })}>
              {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn-primary col-span-2 md:col-span-4">Add</button>
          </form>
          <ul className="mt-3 space-y-2 max-h-56 overflow-auto scrollbar">
            {emis.map((e) => (
              <motion.li key={e.id}
                initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-3 py-2"
              >
                <div>
                  <div className="font-medium">{e.label} <span className="pill ml-1">{e.category}</span></div>
                  <div className="text-sm text-white/60">{money(e.amount)}</div>
                </div>
                <button onClick={() => delEmi(e.id)} className="text-rose hover:text-white transition">Remove</button>
              </motion.li>
            ))}
            {!emis.length && <li className="text-white/50 text-sm">No EMIs yet.</li>}
          </ul>
        </motion.div>
      </div>

      <motion.div className="card" whileHover={{ y: -2 }}>
        <h2 className="font-semibold mb-2">Recommendations</h2>
        <ul className="list-disc pl-5 text-white/80 space-y-1">
          {plan?.tips?.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      </motion.div>
    </div>
  );
}

function Stat({ label, value, tint }) {
  return (
    <motion.div whileHover={{ y: -3 }}
      className={`card relative overflow-hidden`}
    >
      <div className={`absolute -top-10 -right-10 w-40 h-40 rounded-full blur-3xl bg-gradient-to-br ${tint} to-transparent`} />
      <div className="relative">
        <div className="text-sm text-white/60">{label}</div>
        <div className="text-3xl font-bold tracking-tight">{value}</div>
      </div>
    </motion.div>
  );
}
