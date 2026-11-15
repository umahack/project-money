import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, getUser } from '../api/client.js';

const money = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(
    Math.max(0, Math.round(n || 0))
  );

export default function Admin() {
  const me = getUser();
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    setLoading(true);
    try {
      const [s, u, f] = await Promise.all([
        api('/admin/stats'),
        api('/admin/users'),
        api('/admin/feedback'),
      ]);
      setStats(s);
      setUsers(u.users);
      setFeedback(f.feedback);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function deleteFeedback(id) {
    if (!confirm('Delete this feedback entry?')) return;
    await api(`/admin/feedback/${id}`, { method: 'DELETE' });
    await loadAll();
  }

  async function openUser(id) {
    try {
      const d = await api(`/admin/users/${id}`);
      setSelected(d);
    } catch (e) { setErr(e.message); }
  }

  async function overrideSalary(id) {
    const month = prompt('Month (YYYY-MM)', new Date().toISOString().slice(0, 7));
    if (!month) return;
    const amtStr = prompt('New salary amount');
    if (amtStr == null) return;
    const amount = Number(amtStr);
    if (!Number.isFinite(amount) || amount < 0) return alert('Invalid amount');
    await api(`/admin/users/${id}/salary`, { method: 'PUT', body: { amount, month } });
    await openUser(id);
    await loadAll();
  }

  async function toggleAdmin(u) {
    if (!confirm(`${u.is_admin ? 'Demote' : 'Promote'} ${u.email}?`)) return;
    try {
      await api(`/admin/users/${u.id}/admin`, { method: 'PUT', body: { is_admin: !u.is_admin } });
      await loadAll();
      if (selected?.user.id === u.id) await openUser(u.id);
    } catch (e) { alert(e.message); }
  }

  async function deleteUser(u) {
    if (!confirm(`Permanently delete ${u.email} and all their data?`)) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      setSelected(null);
      await loadAll();
    } catch (e) { alert(e.message); }
  }

  async function deleteEmi(id) {
    if (!confirm('Delete this EMI?')) return;
    await api(`/admin/emis/${id}`, { method: 'DELETE' });
    if (selected) await openUser(selected.user.id);
  }

  async function deleteTrip(id) {
    if (!confirm('Delete this trip and its expenses?')) return;
    await api(`/admin/trips/${id}`, { method: 'DELETE' });
    if (selected) await openUser(selected.user.id);
  }

  useEffect(() => { loadAll().catch((e) => setErr(e.message)); }, []);

  const filtered = users.filter(
    (u) => !q || u.email.toLowerCase().includes(q.toLowerCase()) || u.name.toLowerCase().includes(q.toLowerCase())
  );

  if (!me?.is_admin) {
    return <div className="card text-white/80">You are not an admin.</div>;
  }

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
            <p className="text-white/70 text-sm">Manage users, override salaries, and clean up data.</p>
          </div>
          <input
            className="input max-w-xs"
            placeholder="Search by name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </motion.div>

      {err && <div className="text-rose-300">{err}</div>}

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          <Stat label="Users" value={stats.users} />
          <Stat label="Admins" value={stats.admins} />
          <Stat label="Trips" value={stats.trips} />
          <Stat label="EMIs" value={stats.emis} />
          <Stat label="Total Income" value={money(stats.total_income)} />
          <Stat label="Total EMI" value={money(stats.total_emi)} />
          <Stat label="Feedback" value={stats.feedback_count ?? 0} />
          <Stat label="Avg Rating" value={stats.avg_rating ? `${stats.avg_rating} ★` : '—'} />
        </div>
      )}

      <div className="grid lg:grid-cols-5 gap-6">
        <motion.div className="card lg:col-span-2" whileHover={{ y: -2 }}>
          <h2 className="font-semibold mb-3 text-white">Users {loading && <span className="text-white/60 text-xs">loading…</span>}</h2>
          <ul className="divide-y divide-white/10 max-h-[60vh] overflow-auto scrollbar">
            <AnimatePresence>
              {filtered.map((u) => (
                <motion.li
                  key={u.id}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className={`py-2 cursor-pointer transition hover:bg-white/5 px-2 rounded-lg ${selected?.user.id === u.id ? 'bg-white/10' : ''}`}
                  onClick={() => openUser(u.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-white font-medium">
                        {u.name} {u.is_admin ? <span className="pill ml-1">admin</span> : null}
                        {u.id === me.id ? <span className="pill ml-1">you</span> : null}
                      </div>
                      <div className="text-white/70 text-xs">{u.email}</div>
                    </div>
                    <div className="text-right text-xs text-white/70">
                      <div>Salary {money(u.latest_salary)}</div>
                      <div>EMI {money(u.emi_total)} · {u.trip_count} trip(s)</div>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
            {!filtered.length && <li className="text-white/60 py-4 text-sm">No users match.</li>}
          </ul>
        </motion.div>

        <motion.div className="card lg:col-span-3 space-y-6" whileHover={{ y: -2 }}>
          {selected ? (
            <UserDetail
              data={selected}
              me={me}
              onOverrideSalary={() => overrideSalary(selected.user.id)}
              onToggleAdmin={() => toggleAdmin(selected.user)}
              onDeleteUser={() => deleteUser(selected.user)}
              onDeleteEmi={deleteEmi}
              onDeleteTrip={deleteTrip}
            />
          ) : (
            <div className="text-white/70">Select a user on the left.</div>
          )}
        </motion.div>
      </div>

      <motion.div className="card" whileHover={{ y: -2 }}>
        <h2 className="font-semibold text-white mb-3">User feedback</h2>
        {feedback.length ? (
          <ul className="divide-y divide-white/10">
            {feedback.map((f) => (
              <li key={f.id} className="py-3 flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-amber">{'★'.repeat(f.rating)}<span className="text-white/30">{'★'.repeat(5 - f.rating)}</span></span>
                    <span className="text-white/70 text-sm">{f.email || 'anonymous'}</span>
                    <span className="text-white/50 text-xs">· {f.created_at}</span>
                  </div>
                  {f.message && <div className="text-white mt-1 whitespace-pre-wrap">{f.message}</div>}
                </div>
                <button
                  onClick={() => deleteFeedback(f.id)}
                  className="text-rose-300 hover:text-white transition text-sm"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-white/70 text-sm">No feedback yet.</div>
        )}
      </motion.div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <motion.div whileHover={{ y: -2 }} className="rounded-xl bg-white/5 border border-white/10 p-3">
      <div className="text-xs uppercase tracking-wider text-white/70">{label}</div>
      <div className="text-xl font-bold text-white">{value}</div>
    </motion.div>
  );
}

function UserDetail({ data, me, onOverrideSalary, onToggleAdmin, onDeleteUser, onDeleteEmi, onDeleteTrip }) {
  const { user, salaries, emis, trips } = data;
  const isSelf = user.id === me.id;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xl font-bold text-white">{user.name}</div>
          <div className="text-white/70 text-sm">{user.email} · joined {user.created_at}</div>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onOverrideSalary}>Override salary</button>
          <button className="btn-ghost" onClick={onToggleAdmin} disabled={isSelf}>
            {user.is_admin ? 'Demote' : 'Promote'}
          </button>
          <button className="btn-ghost text-rose-300" onClick={onDeleteUser} disabled={isSelf}>
            Delete user
          </button>
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-white mb-2">Salary history</h3>
        {salaries.length ? (
          <ul className="divide-y divide-white/10">
            {salaries.map((s) => (
              <li key={s.month} className="flex items-center justify-between py-2">
                <span className="text-white">{s.month}</span>
                <span className="font-semibold text-white">{money(s.amount)}</span>
              </li>
            ))}
          </ul>
        ) : <div className="text-white/60 text-sm">No salary entries.</div>}
      </div>

      <div>
        <h3 className="font-semibold text-white mb-2">EMIs</h3>
        {emis.length ? (
          <ul className="divide-y divide-white/10">
            {emis.map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-white">{e.label} <span className="pill ml-1">{e.category}</span></div>
                  <div className="text-white/60 text-xs">{money(e.amount)}</div>
                </div>
                <button className="text-rose-300 hover:text-white transition" onClick={() => onDeleteEmi(e.id)}>Delete</button>
              </li>
            ))}
          </ul>
        ) : <div className="text-white/60 text-sm">No EMIs.</div>}
      </div>

      <div>
        <h3 className="font-semibold text-white mb-2">Trips</h3>
        {trips.length ? (
          <ul className="divide-y divide-white/10">
            {trips.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-white">{t.name} <span className="text-white/60 text-xs">· {t.destination || '—'}</span></div>
                  <div className="text-white/60 text-xs">Budget {money(t.budget)} · {t.start_date || '—'} → {t.end_date || '—'}</div>
                </div>
                <button className="text-rose-300 hover:text-white transition" onClick={() => onDeleteTrip(t.id)}>Delete</button>
              </li>
            ))}
          </ul>
        ) : <div className="text-white/60 text-sm">No trips.</div>}
      </div>
    </div>
  );
}
