import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api/client.js';

const money = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

export default function Trips() {
  const [trips, setTrips] = useState([]);
  const [form, setForm] = useState({ name: '', destination: '', budget: '', startDate: '', endDate: '' });
  const [err, setErr] = useState('');

  async function load() {
    const { trips } = await api('/trips');
    setTrips(trips);
  }
  useEffect(() => { load().catch((e) => setErr(e.message)); }, []);

  async function create(e) {
    e.preventDefault();
    setErr('');
    const budget = Number(form.budget);
    if (!form.name.trim() || !Number.isFinite(budget) || budget < 0) return setErr('Add a name and valid budget');
    const payload = { name: form.name.trim(), destination: form.destination.trim(), budget };
    if (form.startDate) payload.startDate = form.startDate;
    if (form.endDate) payload.endDate = form.endDate;
    try {
      await api('/trips', { method: 'POST', body: payload });
      setForm({ name: '', destination: '', budget: '', startDate: '', endDate: '' });
      await load();
    } catch (e) { setErr(e.message); }
  }

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card">
        <h1 className="text-2xl font-bold mb-4">Plan a trip</h1>
        <form onSubmit={create} className="grid md:grid-cols-5 gap-2">
          <input className="input md:col-span-2" placeholder="Trip name"
            value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input md:col-span-2" placeholder="Destination"
            value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
          <input className="input" inputMode="decimal" placeholder="Budget"
            value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          <input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          <input className="input" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          <button className="btn-primary md:col-span-3">Create trip</button>
        </form>
        {err && <div className="text-rose mt-2">{err}</div>}
      </motion.div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {trips.map((t) => (
          <motion.div
            key={t.id}
            whileHover={{ y: -4, rotate: -0.3 }}
            className="card group cursor-pointer"
          >
            <Link to={`/trips/${t.id}`} className="block">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-lg">{t.name}</div>
                <span className="pill">{money(t.budget)}</span>
              </div>
              <div className="text-white/60 text-sm mt-1">{t.destination || '—'}</div>
              <div className="text-white/50 text-xs mt-2">
                {t.start_date || '—'} → {t.end_date || '—'}
              </div>
              <div className="mt-3 text-mint group-hover:translate-x-1 transition">Open →</div>
            </Link>
          </motion.div>
        ))}
        {!trips.length && <div className="text-white/50">No trips yet. Plan one above.</div>}
      </div>
    </div>
  );
}
