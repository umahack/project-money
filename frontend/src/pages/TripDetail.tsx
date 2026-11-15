import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api, ApiError } from '../api';
import { Card, Empty, Field, Money, ProgressBar, Spinner, burst } from '../components/ui';
import { fmtDate, inr, parseAmount, toPaise } from '../money';
import { errText, useAuth, useToast } from '../state';
import type { TripDetailData } from '../types';

/**
 * The API has no separate "settlement" record. A settlement is stored as a normal expense paid by the
 * person who pays back, split 100% onto the person receiving the money, so the existing balance maths
 * cancels the debt. The prefix marks it so the UI can show it as a payment and keep it out of "spent".
 */
export const SETTLE_PREFIX = '↔ Settlement: ';
const isSettlement = (description: string) => description.startsWith(SETTLE_PREFIX);

export function TripDetail() {
  const { id } = useParams();
  const { toast } = useToast();
  const [d, setD] = useState<TripDetailData | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await api.get<TripDetailData>(`/trips/${id}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else toast('err', errText(e));
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <Card>
        <Empty emoji="🧭" title="Trip not found" text="It may have been deleted, or it belongs to another account." />
        <div className="center"><Link className="btn" to="/trips">Back to trips</Link></div>
      </Card>
    );
  }
  if (!d) return <Spinner />;

  return (
    <>
      <div className="crumbs"><Link to="/trips">← All trips</Link></div>
      <Header d={d} />
      <div className="grid two">
        <div className="stack">
          <AddExpense d={d} reload={load} />
          <Ledger d={d} />
        </div>
        <div className="stack">
          <Balances d={d} reload={load} />
          <People d={d} reload={load} />
        </div>
      </div>
    </>
  );
}

function Header({ d }: { d: TripDetailData }) {
  const spent = d.expenses.filter((e) => !isSettlement(e.description)).reduce((s, e) => s + e.amount, 0);
  const left = d.trip.budget - spent;
  return (
    <Card tilt className="trip-header">
      <div className="row between wrap">
        <div>
          <h1>{d.trip.name}</h1>
          <p className="muted">📍 {d.trip.destination || 'No destination'} · 📅 {d.trip.start_date || '—'} → {d.trip.end_date || '—'}</p>
        </div>
      </div>
      <div className="stat-row">
        <div><span className="muted">Spent</span><Money value={spent} className="big" /></div>
        <div><span className="muted">Budget</span><Money value={d.trip.budget} className="big" /></div>
        <div><span className="muted">{left >= 0 ? 'Remaining' : 'Over budget'}</span><Money value={Math.abs(left)} className={`big ${left < 0 ? 'neg' : 'accent'}`} /></div>
      </div>
      {d.trip.budget > 0 && <ProgressBar value={spent} max={d.trip.budget} />}
    </Card>
  );
}

function AddExpense({ d, reload }: { d: TripDetailData; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const names = d.members.map((m) => m.name);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(names));
  const [custom, setCustom] = useState(false);
  const [shares, setShares] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // When the crew changes: forget removed names, select anyone newly added, and keep a valid payer.
  const known = useRef(new Set(names));
  useEffect(() => {
    const now = new Set(d.members.map((m) => m.name));
    setChosen((prev) => {
      const next = new Set([...prev].filter((n) => now.has(n)));
      now.forEach((n) => { if (!known.current.has(n)) next.add(n); });
      return next;
    });
    known.current = now;
    setPayer((p) => (p && now.has(p) ? p : d.members[0]?.name ?? ''));
  }, [d.members]);

  const total = parseAmount(amount || '0') ?? 0;
  const customSum = [...chosen].reduce((s, n) => s + toPaise(parseAmount(shares[n] || '0') ?? 0), 0);
  const perHead = chosen.size > 0 && total > 0 ? total / chosen.size : 0;

  const toggle = (n: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = parseAmount(amount);
    if (!description.trim()) return toast('err', 'What was this for?');
    if (value === null || value === 0) return toast('err', 'Enter a valid amount');
    if (!payer) return toast('err', 'Choose who paid');
    if (chosen.size === 0) return toast('err', 'Choose who shares this expense');
    if (custom && customSum !== toPaise(value)) return toast('err', `Shares add up to ${inr(customSum / 100)} but the bill is ${inr(value)}`);
    const split = [...chosen]
      .map((name) => ({ name, share: custom ? parseAmount(shares[name] || '0') ?? 0 : 1 }))
      .filter((s) => s.share > 0);
    if (split.length === 0) return toast('err', 'Give at least one person a share');
    setBusy(true);
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      await api.post(`/trips/${d.trip.id}/expenses`, { payer, description: description.trim(), amount: value, split });
      setDescription('');
      setAmount('');
      setShares({});
      await reload();
      toast('ok', 'Expense added and split');
      burst(rect.right - 60, rect.top + 40);
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (d.members.length === 0) {
    return (
      <Card>
        <h2>➕ Add an expense</h2>
        <Empty emoji="👥" title="Add your crew first" text="Add yourself and your friends in “Friends on this trip”, then you can split expenses." />
      </Card>
    );
  }

  return (
    <Card>
      <h2>➕ Add an expense</h2>
      <form onSubmit={submit} className="expense-form">
        <div className="grid two tight">
          <Field label="What for?"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Beach shack dinner" maxLength={100} /></Field>
          <Field label="Amount (₹)"><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="2,400" maxLength={16} /></Field>
          <Field label="Paid by">
            <select value={payer} onChange={(e) => setPayer(e.target.value)}>
              {d.members.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="row between wrap">
          <strong>Split between</strong>
          <div className="segmented sm">
            <button type="button" className={!custom ? 'on' : ''} onClick={() => setCustom(false)}>Equally</button>
            <button type="button" className={custom ? 'on' : ''} onClick={() => setCustom(true)}>Custom</button>
          </div>
        </div>
        <ul className="chips">
          {d.members.map((m) => (
            <li key={m.id}>
              <label className={`chip ${chosen.has(m.name) ? 'on' : ''}`}>
                <input type="checkbox" checked={chosen.has(m.name)} onChange={() => toggle(m.name)} />
                <span>{m.name}</span>
              </label>
              {custom && chosen.has(m.name) && (
                <input className="share-input" value={shares[m.name] ?? ''} onChange={(e) => setShares({ ...shares, [m.name]: e.target.value })} inputMode="decimal" placeholder="₹" aria-label={`Share for ${m.name}`} maxLength={16} />
              )}
            </li>
          ))}
        </ul>
        {!custom && perHead > 0 && <p className="muted small">≈ {inr(perHead)} each</p>}
        {custom && total > 0 && (
          <p className={`small ${customSum === toPaise(total) ? 'ok-text' : 'err-text'}`}>
            {customSum === toPaise(total) ? 'Shares match the bill ✓' : `${inr(Math.abs(toPaise(total) - customSum) / 100)} ${customSum < toPaise(total) ? 'left to assign' : 'over'}`}
          </p>
        )}
        <motion.button className="btn primary block" whileTap={{ scale: 0.97 }} disabled={busy} type="submit">{busy ? 'Adding…' : 'Add & split'}</motion.button>
      </form>
    </Card>
  );
}

function Ledger({ d }: { d: TripDetailData }) {
  return (
    <Card>
      <h2>🧾 Expenses</h2>
      {d.expenses.length === 0 ? (
        <Empty emoji="🧾" title="Nothing spent yet" text="Add the first expense above." />
      ) : (
        <ul className="list">
          <AnimatePresence initial={false}>
            {d.expenses.map((e) => {
              const settle = isSettlement(e.description);
              const equal = e.split.length > 0 && e.split.every((s) => s.share === e.split[0]!.share);
              return (
                <motion.li key={e.id} layout initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} className="list-item hoverable">
                  <span className="avatar">{settle ? '🤝' : '🧾'}</span>
                  <div className="grow">
                    <strong>{settle ? `${e.payer} paid ${e.split[0]?.name ?? ''}` : e.description}</strong>
                    <small className="muted">
                      {settle ? 'Settlement' : `${e.payer} paid · ${equal ? `split ${e.split.length} ${e.split.length === 1 ? 'way' : 'ways'}` : 'custom split'}`} · {fmtDate(e.created_at)}
                    </small>
                  </div>
                  <b className={`mono ${settle ? 'ok-text' : ''}`}>{inr(e.amount)}</b>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

function Balances({ d, reload }: { d: TripDetailData; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const [busyKey, setBusyKey] = useState('');
  const rows = useMemo(() => {
    const names = new Set(d.members.map((m) => m.name));
    Object.keys(d.settlement.balances).forEach((n) => names.add(n));
    return [...names].map((name) => ({ name, bal: Math.round((d.settlement.balances[name] ?? 0) * 100) / 100 }));
  }, [d]);

  async function settle(t: { from: string; to: string; amount: number }, e: React.MouseEvent) {
    const key = `${t.from}>${t.to}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      await api.post(`/trips/${d.trip.id}/expenses`, {
        payer: t.from,
        description: `${SETTLE_PREFIX}${t.from} → ${t.to}`.slice(0, 100),
        amount: t.amount,
        split: [{ name: t.to, share: 1 }],
      });
      burst(e.clientX, e.clientY);
      await reload();
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setBusyKey('');
    }
  }

  return (
    <Card tilt>
      <h2>⚖️ Who owes whom</h2>
      {rows.length === 0 ? (
        <p className="muted">Add people and expenses to see balances.</p>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.name} className="list-item">
              <span className="avatar">{r.name.slice(0, 1).toUpperCase()}</span>
              <div className="grow"><strong>{r.name}</strong></div>
              <span className={`balance-chip ${r.bal > 0.01 ? 'plus' : r.bal < -0.01 ? 'minus' : ''}`}>
                {r.bal > 0.01 ? `gets ${inr(r.bal)}` : r.bal < -0.01 ? `owes ${inr(-r.bal)}` : 'settled'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {d.settlement.transactions.length > 0 ? (
        <>
          <h3>Simplest way to settle up</h3>
          <ul className="list">
            {d.settlement.transactions.map((t) => (
              <li key={`${t.from}>${t.to}`} className="list-item">
                <div className="grow"><b>{t.from}</b> pays <b>{t.to}</b></div>
                <b className="mono">{inr(t.amount)}</b>
                <button className="btn sm" disabled={!!busyKey} onClick={(e) => void settle(t, e)}>Mark paid</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        d.expenses.length > 0 && <p className="ok-text">All square 🎉</p>
      )}
    </Card>
  );
}

function People({ d, reload }: { d: TripDetailData; reload: () => Promise<void> }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const isOwner = d.role === 'owner';

  async function add(memberName: string, memberEmail?: string) {
    setBusy(true);
    try {
      await api.post(`/trips/${d.trip.id}/members`, { name: memberName, ...(memberEmail ? { email: memberEmail } : {}) });
      await reload();
      toast('ok', `${memberName} added`);
      return true;
    } catch (err) {
      toast('err', err instanceof ApiError && err.status === 409 ? 'Someone with that name is already on this trip' : errText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return toast('err', "Enter your friend's name");
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return toast('err', 'That email looks off');
    if (await add(name.trim(), email.trim() || undefined)) {
      setName('');
      setEmail('');
    }
  }

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    const em = inviteEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast('err', 'Enter a valid email');
    setInviting(true);
    try {
      await api.post(`/trips/${d.trip.id}/invite`, { email: em });
      toast('ok', `Invite sent to ${em}`);
      setInviteEmail('');
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setInviting(false);
    }
  }

  const meMissing = !!user && !d.members.some((m) => m.email?.toLowerCase() === user.email.toLowerCase() || m.name.toLowerCase() === user.name.toLowerCase());

  return (
    <Card>
      <h2>👥 Friends on this trip</h2>
      {d.members.length === 0 ? (
        <p className="muted">Nobody yet. Add yourself and your crew.</p>
      ) : (
        <ul className="list">
          {d.members.map((m) => (
            <li key={m.id} className="list-item">
              <span className="avatar">{m.name.slice(0, 1).toUpperCase()}</span>
              <div className="grow">
                <strong>{m.name}</strong>
                {m.email && <small className="muted">{m.email}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {meMissing && (
        <button className="btn sm" style={{ marginTop: '0.8rem' }} disabled={busy} onClick={() => void add(user!.name.slice(0, 40), user!.email)}>
          + Add me ({user!.name.split(' ')[0]})
        </button>
      )}

      {isOwner && (
        <form onSubmit={sendInvite} className="stack-sm" style={{ marginTop: '1rem' }}>
          <h3 style={{ margin: 0 }}>✉️ Invite a registered friend</h3>
          <Field
            label="Friend's email"
            hint="They need an account. On their next login they'll see the invite and can accept to join this trip."
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              maxLength={254}
              placeholder="friend@example.com"
            />
          </Field>
          <button className="btn" type="submit" disabled={inviting}>
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </form>
      )}

      <form onSubmit={submit} className="stack-sm" style={{ marginTop: '1rem' }}>
        <h3 style={{ margin: 0 }}>➕ Add an offline friend (label only)</h3>
        <Field label="Friend's name" hint="Use this when they don't have an account — they appear in splits by name.">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Ravi" />
        </Field>
        <Field label="Email (optional)">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} placeholder="ravi@example.com" />
        </Field>
        <button className="btn ghost" type="submit" disabled={busy}>Add label</button>
      </form>
    </Card>
  );
}
