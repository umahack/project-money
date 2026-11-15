import { useEffect, useState, type FormEvent } from 'react';
import { api, setAuth } from '../api';
import type { User } from '../types';
import { Card, Field } from './ui';
import { errText, useAuth, useToast } from '../state';

export function ProfileSettings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(user?.name ?? '');
    setEmail(user?.email ?? '');
  }, [user?.name, user?.email]);

  const changed = name.trim() !== (user?.name ?? '') || email.trim() !== (user?.email ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!changed) return;
    if (!name.trim()) return toast('err', 'Name cannot be empty');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return toast('err', 'That email looks off');
    setBusy(true);
    try {
      const payload: { name?: string; email?: string } = {};
      if (name.trim() !== user?.name) payload.name = name.trim();
      if (email.trim() !== user?.email) payload.email = email.trim();
      const r = await api.patch<{ ok: true; token?: string; user?: User }>('/auth/profile', payload);
      if (r.token && r.user) setAuth(r.token, r.user);
      toast('ok', 'Profile updated');
    } catch (err) { toast('err', errText(err)); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <h2>🪪 Your profile</h2>
      <p className="muted small">
        Update your name or email. Email changes don't require verification yet — an OTP check is coming
        in the next sprint. Keep it an address you actually read.
      </p>
      <form onSubmit={submit} className="stack-sm">
        <Field label="Display name" hint="Shown in the greeting and on trip splits.">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </Field>
        <Field label="Email" hint="This is also your sign-in address. Make sure you can still read it.">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            autoComplete="email"
            required
          />
        </Field>
        <div className="row-sm" style={{ gap: '0.5rem' }}>
          <button className="btn primary" type="submit" disabled={busy || !changed}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {changed && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => { setName(user?.name ?? ''); setEmail(user?.email ?? ''); }}
              disabled={busy}
            >
              Reset
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
