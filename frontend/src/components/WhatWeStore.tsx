import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from './ui';

const FIELDS: Array<{ name: string; why: string }> = [
  { name: 'Email + name', why: 'Sign in and address you by name.' },
  { name: 'Salted + hashed password', why: 'bcrypt, not reversible.' },
  { name: 'Monthly take-home pay', why: 'Builds your 50/30/20 plan.' },
  { name: 'Your fixed bills', why: 'Subtracted from pay to get disposable income.' },
  { name: 'Expenses you log', why: 'Shown back to you as Spent / Remaining.' },
  { name: 'Your trips + members', why: 'Trip budget + Splitwise-style balances.' },
  { name: 'Session tokens (max 3 devices)', why: 'Kept so you stay signed in.' },
];

const NOT_STORED = [
  'Bank account or card numbers',
  'Debit/credit transaction history',
  'Location, device fingerprint, or advertising IDs',
  'Anything shared with third parties',
];

export function WhatWeStoreLink({ className = 'link' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        What we store
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="What Project Money stores about you">
        <h2 style={{ marginTop: 0 }}>What we store, and why</h2>
        <p className="muted small">
          Everything Project Money keeps about you fits on this one screen. You can export
          it or delete it anytime from Settings.
        </p>
        <h3 style={{ marginBottom: 4 }}>Stored</h3>
        <ul className="list">
          {FIELDS.map((f) => (
            <li key={f.name} className="list-item">
              <div className="grow">
                <strong>{f.name}</strong>
                <small className="muted">{f.why}</small>
              </div>
            </li>
          ))}
        </ul>
        <h3 style={{ margin: '0.8rem 0 4px' }}>Never stored</h3>
        <ul className="muted small" style={{ marginTop: 0, paddingLeft: '1.1rem' }}>
          {NOT_STORED.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <div className="row end" style={{ marginTop: '0.8rem', gap: '0.5rem' }}>
          <Link className="btn ghost sm" to="/settings" onClick={() => setOpen(false)}>Export or delete</Link>
          <button className="btn sm" onClick={() => setOpen(false)}>Got it</button>
        </div>
      </Modal>
    </>
  );
}
