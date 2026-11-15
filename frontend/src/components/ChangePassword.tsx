import { useState, type FormEvent } from 'react';
import { api, setAuth } from '../api';
import type { User } from '../types';
import { Card, Field } from './ui';
import { errText, useToast } from '../state';

const RULES = [
  { key: 'len', label: 'At least 8 characters', test: (p: string) => p.length >= 8 },
  { key: 'letter', label: 'Contains a letter', test: (p: string) => /[A-Za-z]/.test(p) },
  { key: 'number', label: 'Contains a number', test: (p: string) => /\d/.test(p) },
];

export function ChangePassword() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [showCur, setShowCur] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [busy, setBusy] = useState(false);

  const checks = RULES.map((r) => ({ ...r, ok: r.test(next) }));
  const canSubmit = current.length > 0 && checks.every((c) => c.ok) && current !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      const missing = checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase());
      if (missing.length) return toast('err', `New password needs: ${missing.join(', ')}`);
      if (current === next) return toast('err', 'New password must differ from the current one');
      return toast('err', 'Fill both fields');
    }
    setBusy(true);
    try {
      const res = await api.post<{ ok: true; token?: string; user?: User }>('/auth/password', {
        currentPassword: current,
        newPassword: next,
      });
      if (res.token && res.user) setAuth(res.token, res.user);
      setCurrent(''); setNext('');
      setOpen(false);
      toast('ok', 'Password updated. Other devices have been signed out.');
    } catch (err) {
      toast('err', errText(err));
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <Card>
        <h2>🔑 Account security</h2>
        <p className="muted small">Rotate your password occasionally — more so if you've shared it with anyone or logged in on a public device.</p>
        <button className="btn ghost" onClick={() => setOpen(true)}>Change password</button>
      </Card>
    );
  }

  return (
    <Card>
      <h2>🔑 Change password</h2>
      <form onSubmit={submit} className="stack-sm" noValidate>
        <Field label="Current password">
          <div className="pw-wrap">
            <input
              type={showCur ? 'text' : 'password'}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              maxLength={128}
            />
            <button type="button" className="pw-toggle" onClick={() => setShowCur((v) => !v)}>{showCur ? 'Hide' : 'Show'}</button>
          </div>
        </Field>
        <Field label="New password">
          <div className="pw-wrap">
            <input
              type={showNext ? 'text' : 'password'}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
            />
            <button type="button" className="pw-toggle" onClick={() => setShowNext((v) => !v)}>{showNext ? 'Hide' : 'Show'}</button>
          </div>
        </Field>
        <ul className="rules" aria-live="polite">
          {checks.map((c) => (
            <li key={c.key} className={c.ok ? 'ok' : ''}>
              <span>{c.ok ? '✓' : '•'}</span> {c.label}
            </li>
          ))}
        </ul>
        <div className="row-sm" style={{ gap: '0.5rem' }}>
          <button className="btn primary" type="submit" disabled={busy || !canSubmit}>
            {busy ? 'Updating…' : 'Update password'}
          </button>
          <button type="button" className="btn ghost" onClick={() => { setOpen(false); setCurrent(''); setNext(''); }}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
