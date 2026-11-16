import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, setAuth } from '../api';
import type { User } from '../types';
import { Card, Field } from './ui';
import { errText, useAuth, useToast } from '../state';

interface Pending {
  newEmail: string;
  expires_at: string;
}

export function ProfileSettings() {
  const { user } = useAuth();
  const { toast } = useToast();

  // --- Name ---
  const [name, setName] = useState(user?.name ?? '');
  const [savingName, setSavingName] = useState(false);

  // --- Email change OTP ---
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busyEmail, setBusyEmail] = useState(false);

  useEffect(() => {
    setName(user?.name ?? '');
  }, [user?.name]);

  const loadPending = useCallback(async () => {
    try {
      const r = await api.get<{ pending: Pending | null }>('/auth/email-change-pending');
      setPending(r.pending);
      if (r.pending) setNewEmail(r.pending.newEmail);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadPending(); }, [loadPending]);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return toast('err', 'Name cannot be empty');
    if (name.trim() === (user?.name ?? '')) return;
    setSavingName(true);
    try {
      const r = await api.patch<{ ok: true; token?: string; user?: User }>('/auth/profile', { name: name.trim() });
      if (r.token && r.user) setAuth(r.token, r.user);
      toast('ok', 'Name updated');
    } catch (err) { toast('err', errText(err)); }
    finally { setSavingName(false); }
  }

  async function startEmailChange(e: FormEvent) {
    e.preventDefault();
    const em = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast('err', 'Enter a valid email');
    if (em === user?.email) return toast('err', 'That is already your email');
    setBusyEmail(true);
    try {
      const r = await api.post<{ ok: true; newEmail: string; mail?: { fallback?: boolean } }>(
        '/auth/email-change-start',
        { newEmail: em },
      );
      toast('ok', r.mail?.fallback ? 'Code generated (check server log in dev)' : `Code sent to ${em}`);
      await loadPending();
      setCode('');
    } catch (err) { toast('err', errText(err)); }
    finally { setBusyEmail(false); }
  }

  async function confirmEmailChange(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return toast('err', 'Enter the 6-digit code');
    setBusyEmail(true);
    try {
      const r = await api.post<{ ok: true; token: string; user: User }>('/auth/email-change-confirm', { code });
      setAuth(r.token, r.user);
      setPending(null);
      setCode('');
      setNewEmail('');
      toast('ok', 'Email updated');
    } catch (err) { toast('err', errText(err)); }
    finally { setBusyEmail(false); }
  }

  async function cancelPending() {
    if (!confirm('Cancel the email change?')) return;
    try {
      await api.del('/auth/email-change-pending');
      setPending(null);
      setCode('');
      toast('ok', 'Cancelled');
    } catch (err) { toast('err', errText(err)); }
  }

  async function resend() {
    if (!pending) return;
    try {
      const r = await api.post<{ ok: true; mail?: { fallback?: boolean } }>(
        '/auth/email-change-start',
        { newEmail: pending.newEmail },
      );
      toast('ok', r.mail?.fallback ? 'New code generated (check server log)' : 'New code sent');
    } catch (err) { toast('err', errText(err)); }
  }

  return (
    <Card>
      <h2>🪪 Your profile</h2>
      <p className="muted small">Current email: <b>{user?.email}</b></p>

      <form onSubmit={saveName} className="stack-sm" style={{ marginTop: '0.8rem' }}>
        <Field label="Display name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </Field>
        <button className="btn primary" type="submit" disabled={savingName || name.trim() === (user?.name ?? '') || !name.trim()}>
          {savingName ? 'Saving…' : 'Save name'}
        </button>
      </form>

      <hr style={{ margin: '1.2rem 0', border: 'none', borderTop: '1px dashed rgba(255,255,255,0.1)' }} />

      <h3>Change email</h3>
      <p className="muted small">
        We'll email a 6-digit code to the <b>new</b> address. Your current email stays active until you
        confirm.
      </p>

      <AnimatePresence mode="wait">
        {!pending ? (
          <motion.form
            key="start"
            onSubmit={startEmailChange}
            className="stack-sm"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
          >
            <Field label="New email">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                maxLength={254}
                placeholder="you@newdomain.com"
                autoComplete="email"
                required
              />
            </Field>
            <button className="btn" type="submit" disabled={busyEmail || !newEmail.trim()}>
              {busyEmail ? 'Sending code…' : 'Send verification code'}
            </button>
          </motion.form>
        ) : (
          <motion.form
            key="confirm"
            onSubmit={confirmEmailChange}
            className="stack-sm"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
          >
            <p className="muted small">We sent a code to <b>{pending.newEmail}</b>.</p>
            <Field label="6-digit code">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                style={{ letterSpacing: '0.4em', textAlign: 'center', fontSize: '1.2rem' }}
                required
              />
            </Field>
            <div className="row-sm" style={{ gap: '0.5rem' }}>
              <button className="btn primary" type="submit" disabled={busyEmail || code.length !== 6}>
                {busyEmail ? 'Confirming…' : 'Confirm new email'}
              </button>
              <button type="button" className="btn ghost" onClick={() => void resend()} disabled={busyEmail}>
                Resend code
              </button>
              <button type="button" className="btn ghost" onClick={() => void cancelPending()} disabled={busyEmail}>
                Cancel
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </Card>
  );
}
