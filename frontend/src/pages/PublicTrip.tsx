import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Card, Empty, Money, ProgressBar } from '../components/ui';
import { Background } from '../components/Shell';
import { fmtDate, inr } from '../money';

interface PublicTripData {
  trip: {
    id: number;
    name: string;
    destination: string | null;
    budget: number;
    start_date: string | null;
    end_date: string | null;
  };
  members: Array<{ id: number; name: string }>;
  expenses: Array<{
    id: number;
    payer: string;
    description: string;
    amount: number;
    created_at: string;
    split: Array<{ name: string; share: number }>;
  }>;
  settlement: {
    balances: Record<string, number>;
    transactions: Array<{ from: string; to: string; amount: number }>;
  };
}

const SETTLE_PREFIX = '↔ Settlement: ';

export function PublicTrip() {
  const { token } = useParams();
  const [d, setD] = useState<PublicTripData | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
        const res = await fetch(`${base}/api/public/trips/${token}`);
        if (res.status === 404) { setMissing(true); return; }
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        setD(await res.json());
      } catch {
        setMissing(true);
      }
    })();
  }, [token]);

  if (missing) {
    return (
      <>
        <Background />
        <main className="container">
          <Card>
            <Empty emoji="🔒" title="Link no longer works" text="The trip owner may have disabled the public share. Ask them for a fresh link." />
            <Link className="btn" to="/login">Go to sign in</Link>
          </Card>
        </main>
      </>
    );
  }
  if (!d) {
    return (
      <>
        <Background />
        <main className="container"><Card><p className="muted">Loading…</p></Card></main>
      </>
    );
  }

  const spent = d.expenses.filter((e) => !e.description.startsWith(SETTLE_PREFIX))
    .reduce((s, e) => s + e.amount, 0);
  const left = Math.max(d.trip.budget - spent, 0);

  return (
    <>
      <Background />
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Project Money home">
          <span className="brand-mark">₹</span>
          <span>Project&nbsp;Money</span>
          <span className="beta-badge" aria-hidden="true">BETA</span>
        </Link>
        <div className="top-actions">
          <Link to="/login" className="btn primary sm">Sign in</Link>
        </div>
      </header>
      <main className="container">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card tilt className="trip-header">
            <div className="row between wrap">
              <div>
                <h1>{d.trip.name}</h1>
                <p className="muted">
                  📍 {d.trip.destination || 'No destination'} · 📅 {fmtDate(d.trip.start_date || '')} → {fmtDate(d.trip.end_date || '')}
                </p>
                <p className="muted small">You're viewing this trip via a public share link. Changes are made by the trip owner.</p>
              </div>
              <div className="stat-row">
                <div><span className="muted">Budget</span><Money value={d.trip.budget} className="big" /></div>
                <div><span className="muted">Spent</span><Money value={spent} className="big" /></div>
                <div><span className="muted">Left</span><Money value={left} className="big" /></div>
              </div>
            </div>
            <ProgressBar value={spent} max={d.trip.budget} />
          </Card>

          <div className="grid two">
            <div className="stack">
              <Card>
                <h2>🧾 Expenses</h2>
                {d.expenses.length === 0 ? (
                  <Empty emoji="🧾" title="No expenses yet" text="Nothing has been logged on this trip." />
                ) : (
                  <ul className="list">
                    {d.expenses.map((e) => (
                      <li key={e.id} className="list-item">
                        <span className="avatar">{e.payer.slice(0, 1).toUpperCase()}</span>
                        <div className="grow">
                          <strong>{e.description}</strong>
                          <small className="muted">Paid by {e.payer} · split {e.split.map((s) => `${s.name}×${s.share}`).join(', ')}</small>
                        </div>
                        <b className="mono">{inr(e.amount)}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <div className="stack">
              <Card>
                <h2>⚖️ Settle up</h2>
                {d.settlement.transactions.length === 0 ? (
                  <p className="ok-text">All square 🎉</p>
                ) : (
                  <ul className="list">
                    {d.settlement.transactions.map((t) => (
                      <li key={`${t.from}>${t.to}`} className="list-item">
                        <div className="grow"><b>{t.from}</b> pays <b>{t.to}</b></div>
                        <b className="mono">{inr(t.amount)}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <h2>👥 On this trip</h2>
                {d.members.length === 0 ? (
                  <p className="muted">No members yet.</p>
                ) : (
                  <ul className="list">
                    {d.members.map((m) => (
                      <li key={m.id} className="list-item">
                        <span className="avatar">{m.name.slice(0, 1).toUpperCase()}</span>
                        <strong>{m.name}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </motion.div>
      </main>
    </>
  );
}
