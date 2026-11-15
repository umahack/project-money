import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, ConfirmDialog, Empty, Field, Modal, PageTitle, Spinner, type ConfirmState } from '../components/ui';
import { currentMonth, fmtDate, inr, parseAmount } from '../money';
import { errText, useAuth, useToast } from '../state';
import type { AdminStats, AdminUserDetail, AdminUserRow, FeedbackRow } from '../types';
import { VisitorsPanel } from '../components/VisitorsPanel';

export function Admin() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [selected, setSelected] = useState<AdminUserDetail | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [salaryFor, setSalaryFor] = useState<AdminUserRow | AdminUserDetail['user'] | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, u, f] = await Promise.all([
        api.get<AdminStats>('/admin/stats'),
        api.get<{ users: AdminUserRow[] }>('/admin/users'),
        api.get<{ feedback: FeedbackRow[] }>('/admin/feedback'),
      ]);
      setStats(s);
      setUsers(u.users);
      setFeedback(f.feedback);
      setErr('');
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (me?.is_admin) void loadAll();
    else setLoading(false);
  }, [loadAll, me?.is_admin]);

  async function openUser(id: number) {
    try {
      setSelected(await api.get<AdminUserDetail>(`/admin/users/${id}`));
      if (window.innerWidth < 820) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    } catch (e) {
      toast('err', errText(e));
    }
  }

  /** Runs an admin action, then refreshes the lists (and the open user, if still there). */
  async function act(fn: () => Promise<unknown>, okMsg: string, refreshUser?: number) {
    try {
      await fn();
      toast('ok', okMsg);
      await loadAll();
      if (refreshUser) await openUser(refreshUser);
    } catch (e) {
      toast('err', errText(e));
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return users.filter((u) => !needle || u.email.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle));
  }, [users, q]);

  if (!me?.is_admin) {
    return (
      <Card><Empty emoji="🔒" title="Admins only" text="Your account does not have admin access." /></Card>
    );
  }
  if (loading) return <Spinner />;

  const selUser = selected?.user;
  const isSelf = selUser?.id === me.id;

  return (
    <>
      <PageTitle
        title="Admin 🛡️"
        sub="Manage users, override salaries and clean up data."
        right={<input className="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />}
      />
      {err && <Card><p className="form-error">{err}</p><button className="btn" onClick={() => void loadAll()}>Retry</button></Card>}

      {stats && (
        <div className="grid stats8">
          <Stat label="Users" value={String(stats.users)} />
          <Stat label="Admins" value={String(stats.admins)} />
          <Stat label="Trips" value={String(stats.trips)} />
          <Stat label="EMIs" value={String(stats.emis)} />
          <Stat label="Total income" value={inr(stats.total_income)} />
          <Stat label="Total EMI" value={inr(stats.total_emi)} />
          <Stat label="Feedback" value={String(stats.feedback_count ?? 0)} />
          <Stat label="Avg rating" value={stats.avg_rating ? `${stats.avg_rating} ★` : '—'} />
        </div>
      )}

      <div className="grid admin-split">
        <Card>
          <h2>👥 Users <small className="muted">({filtered.length})</small></h2>
          <ul className="list scroll">
            <AnimatePresence initial={false}>
              {filtered.map((u) => (
                <motion.li key={u.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <button className={`user-row ${selUser?.id === u.id ? 'on' : ''}`} onClick={() => void openUser(u.id)}>
                    <span className="avatar">{u.name.slice(0, 1).toUpperCase()}</span>
                    <span className="grow">
                      <strong>{u.name} {u.is_admin ? <span className="pill info tiny">admin</span> : null} {u.id === me.id ? <span className="pill tiny">you</span> : null}</strong>
                      <small className="muted">{u.email}</small>
                    </span>
                    <span className="user-meta muted">
                      <span>Salary {inr(u.latest_salary)}</span>
                      <span>EMI {inr(u.emi_total)} · {u.trip_count} trip(s)</span>
                    </span>
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
            {filtered.length === 0 && <li className="muted small">No users match.</li>}
          </ul>
        </Card>

        <div ref={detailRef}>
          <Card>
            {selected && selUser ? (
              <div className="stack-sm nomargin">
                <div className="row between wrap">
                  <div>
                    <h2>{selUser.name}</h2>
                    <p className="muted small">{selUser.email} · joined {fmtDate(selUser.created_at, true)}</p>
                  </div>
                  <div className="row wrap">
                    <button className="btn ghost sm" onClick={() => setSalaryFor(selUser)}>Override salary</button>
                    <button
                      className="btn ghost sm"
                      onClick={() => {
                        const next = prompt(`Set a new password for ${selUser.email}. Minimum 8 characters.\n\nShare it with them privately; they can change it themselves after signing in.`);
                        if (next == null) return;
                        if (next.length < 8) { alert('Password must be at least 8 characters.'); return; }
                        void act(() => api.put(`/admin/users/${selUser.id}/password`, { newPassword: next }), 'Password reset', selUser.id);
                      }}
                    >
                      Reset password
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={isSelf}
                      onClick={() =>
                        setConfirm({
                          title: selUser.is_admin ? 'Demote this admin?' : 'Promote to admin?',
                          text: `${selUser.email} will ${selUser.is_admin ? 'lose' : 'get'} admin access.`,
                          confirmLabel: selUser.is_admin ? 'Demote' : 'Promote',
                          onConfirm: () => act(() => api.put(`/admin/users/${selUser.id}/admin`, { is_admin: !selUser.is_admin }), 'Role updated', selUser.id),
                        })
                      }
                    >
                      {selUser.is_admin ? 'Demote' : 'Promote'}
                    </button>
                    <button
                      className="btn ghost sm danger"
                      disabled={isSelf}
                      onClick={() =>
                        setConfirm({
                          title: 'Delete this user?',
                          text: `${selUser.email} and all of their salaries, EMIs and trips will be permanently deleted.`,
                          confirmLabel: 'Delete user',
                          danger: true,
                          onConfirm: () => act(async () => { await api.del(`/admin/users/${selUser.id}`); setSelected(null); }, 'User deleted'),
                        })
                      }
                    >
                      Delete user
                    </button>
                  </div>
                </div>

                <h3>Salary history</h3>
                {selected.salaries.length ? (
                  <ul className="list">
                    {selected.salaries.map((s) => (
                      <li key={s.month} className="list-item"><span className="grow">{s.month}</span><b className="mono">{inr(s.amount)}</b></li>
                    ))}
                  </ul>
                ) : <p className="muted small">No salary entries.</p>}

                <h3>EMIs &amp; payments</h3>
                {selected.emis.length ? (
                  <ul className="list">
                    {selected.emis.map((e) => (
                      <li key={e.id} className="list-item">
                        <div className="grow"><strong>{e.label}</strong><small className="muted">{e.category}</small></div>
                        <b className="mono">{inr(e.amount)}</b>
                        <button
                          className="icon-btn danger"
                          aria-label={`Delete ${e.label}`}
                          onClick={() => setConfirm({ title: 'Delete this payment?', text: `${e.label} (${inr(e.amount)}) will be removed.`, confirmLabel: 'Delete', danger: true, onConfirm: () => act(() => api.del(`/admin/emis/${e.id}`), 'Payment deleted', selUser.id) })}
                        >🗑️</button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted small">No EMIs.</p>}

                <h3>Trips</h3>
                {selected.trips.length ? (
                  <ul className="list">
                    {selected.trips.map((t) => (
                      <li key={t.id} className="list-item">
                        <div className="grow">
                          <strong>{t.name}</strong>
                          <small className="muted">{t.destination || '—'} · Budget {inr(t.budget)} · {t.start_date || '—'} → {t.end_date || '—'}</small>
                        </div>
                        <button
                          className="icon-btn danger"
                          aria-label={`Delete trip ${t.name}`}
                          onClick={() => setConfirm({ title: 'Delete this trip?', text: `“${t.name}” and all of its members and expenses will be removed.`, confirmLabel: 'Delete trip', danger: true, onConfirm: () => act(() => api.del(`/admin/trips/${t.id}`), 'Trip deleted', selUser.id) })}
                        >🗑️</button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted small">No trips.</p>}
              </div>
            ) : (
              <Empty emoji="👈" title="Select a user" text="Pick someone from the list to see their salaries, EMIs and trips." />
            )}
          </Card>
        </div>
      </div>

      <VisitorsPanel />

      <Card>
        <h2>⭐ User feedback</h2>
        {feedback.length ? (
          <ul className="list">
            {feedback.map((f) => (
              <li key={f.id} className="list-item top">
                <div className="grow">
                  <div className="row wrap">
                    <span className="stars-static" aria-label={`${f.rating} out of 5`}>{'★'.repeat(f.rating)}<span className="dim">{'★'.repeat(5 - f.rating)}</span></span>
                    <span className="muted small">{f.email || 'anonymous'} · {fmtDate(f.created_at, true)}</span>
                  </div>
                  {f.message && <p className="fb-msg">{f.message}</p>}
                </div>
                <button
                  className="icon-btn danger"
                  aria-label="Delete feedback"
                  onClick={() => setConfirm({ title: 'Delete this feedback?', text: 'This entry will be removed for good.', confirmLabel: 'Delete', danger: true, onConfirm: () => act(() => api.del(`/admin/feedback/${f.id}`), 'Feedback deleted') })}
                >🗑️</button>
              </li>
            ))}
          </ul>
        ) : <Empty emoji="💬" title="No feedback yet" />}
      </Card>

      <SalaryDialog
        target={salaryFor}
        onClose={() => setSalaryFor(null)}
        onSave={(id, month, amount) => act(() => api.put(`/admin/users/${id}/salary`, { month, amount }), 'Salary updated', id)}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <motion.div whileHover={{ y: -3 }} className="stat-tile">
      <span className="muted">{label}</span>
      <strong className="mono">{value}</strong>
    </motion.div>
  );
}

function SalaryDialog({ target, onClose, onSave }: { target: { id: number; email: string } | null; onClose: () => void; onSave: (id: number, month: string, amount: number) => Promise<void> }) {
  const { toast } = useToast();
  const [month, setMonth] = useState(currentMonth());
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(target);
  if (target) last.current = target;
  const t = target ?? last.current;

  useEffect(() => {
    if (target) {
      setMonth(currentMonth());
      setAmount('');
    }
  }, [target]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return toast('err', 'Month must look like 2025-03');
    const v = parseAmount(amount);
    if (v === null) return toast('err', 'Enter a valid amount');
    setBusy(true);
    await onSave(target.id, month, v);
    setBusy(false);
    onClose();
  }

  return (
    <Modal open={!!target} onClose={onClose} title="Override salary" locked={busy}>
      <h2>Override salary</h2>
      <p className="muted">{t?.email}</p>
      <form onSubmit={submit}>
        <Field label="Month (YYYY-MM)"><input value={month} onChange={(e) => setMonth(e.target.value)} placeholder="2025-03" maxLength={7} inputMode="numeric" /></Field>
        <Field label="Amount (₹)"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="80,000" inputMode="decimal" maxLength={16} autoFocus /></Field>
        <div className="row end">
          <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
