import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field } from './ui';
import { errText, useToast } from '../state';

interface Alias {
  id: number;
  email: string;
  created_at: string;
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
      await api.post('/aliases', { email: em });
      setEmail('');
      toast('ok', `Linked ${em}`);
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
        Add up to five email addresses that can log in to this account. Trip invites sent to any of
        these show up on your Home page too.
      </p>
      {items && items.length > 0 && (
        <ul className="list">
          <AnimatePresence>
            {items.map((a) => (
              <motion.li
                key={a.id}
                className="list-item"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -16 }}
                layout
              >
                <span className="avatar">@</span>
                <div className="grow">
                  <strong>{a.email}</strong>
                  <small className="muted">linked {a.created_at.slice(0, 10)}</small>
                </div>
                <button
                  className="btn sm ghost"
                  disabled={removing === a.id}
                  onClick={() => void remove(a.id)}
                >
                  {removing === a.id ? '…' : 'Remove'}
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      {items && items.length === 0 && <p className="muted small">No linked emails yet.</p>}
      <form onSubmit={add} className="stack-sm" style={{ marginTop: '0.6rem' }}>
        <Field label="Add an email" hint="You'll be able to log in with this email + your current password.">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            placeholder="work@company.com"
          />
        </Field>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Linking…' : 'Link this email'}
        </button>
      </form>
    </Card>
  );
}
