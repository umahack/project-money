import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field } from './ui';
import { errText, useToast } from '../state';

interface Alias {
  id: number;
  email: string;
  verified: boolean;
  created_at: string;
  verified_at: string | null;
}

export function AliasManager() {
  const { toast } = useToast();
  const [items, setItems] = useState<Alias[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ aliases: Alias[] }>('/aliases');
      setItems(data.aliases);
    } catch (e) {
      toast('err', errText(e));
      setItems([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const em = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast('err', 'Enter a valid email');
    setBusy(true);
    try {
      const res = await api.post<{ mail?: { fallback?: boolean } }>('/aliases', { email: em });
      setEmail('');
      toast('ok', res.mail?.fallback ? 'Verification code sent (check the server log in dev)' : `Verification code sent to ${em}`);
      await load();
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('Remove this linked email? You will no longer be able to log in with it.')) return;
    setRemoving(id);
    try {
      await api.del(`/aliases/${id}`);
      await load();
      toast('ok', 'Removed');
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card>
      <h2>🔗 Linked emails</h2>
      <p className="muted small">
        Add up to five email addresses. Each one is confirmed with a 6-digit code sent to that
        address — only after you enter the code can it be used to log in or receive trip invites.
      </p>
      {items && items.length > 0 && (
        <ul className="list">
          <AnimatePresence>
            {items.map((a) => (
              <AliasRow key={a.id} alias={a} onChange={load} onRemove={() => void remove(a.id)} removing={removing === a.id} />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {items && items.length === 0 && <p className="muted small">No linked emails yet.</p>}
      <form onSubmit={add} className="stack-sm" style={{ marginTop: '0.6rem' }}>
        <Field label="Add an email" hint="We'll email a 6-digit confirmation code before it's active.">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            placeholder="work@company.com"
          />
        </Field>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Sending code…' : 'Link this email'}
        </button>
      </form>
    </Card>
  );
}

function AliasRow({ alias, onChange, onRemove, removing }: {
  alias: Alias;
  onChange: () => Promise<void>;
  onRemove: () => void;
  removing: boolean;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return toast('err', 'Enter the 6-digit code.');
    setVerifying(true);
    try {
      await api.post(`/aliases/${alias.id}/verify`, { code });
      toast('ok', `${alias.email} verified`);
      setCode('');
      await onChange();
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setVerifying(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      const res = await api.post<{ mail?: { fallback?: boolean } }>(`/aliases/${alias.id}/resend`, {});
      toast('ok', res.mail?.fallback ? 'New code sent (check server log in dev)' : 'New code sent');
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <motion.li
      className="list-item"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16 }}
      layout
    >
      <span className="avatar">@</span>
      <div className="grow">
        <strong>{alias.email}</strong>
        <small className="muted">
          {alias.verified ? `verified ${alias.verified_at?.slice(0, 10) ?? ''}` : 'pending — enter the code we emailed to confirm'}
        </small>
        {!alias.verified && (
          <form onSubmit={verify} className="row-sm" style={{ marginTop: '0.4rem' }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="123456"
              maxLength={6}
              style={{ width: 110, letterSpacing: '0.3em', textAlign: 'center' }}
            />
            <button className="btn sm" type="submit" disabled={verifying || code.length !== 6}>
              {verifying ? '…' : 'Verify'}
            </button>
            <button type="button" className="btn sm ghost" disabled={resending} onClick={() => void resend()}>
              {resending ? '…' : 'Resend'}
            </button>
          </form>
        )}
      </div>
      <button className="btn sm ghost" disabled={removing} onClick={onRemove}>
        {removing ? '…' : 'Remove'}
      </button>
    </motion.li>
  );
}
