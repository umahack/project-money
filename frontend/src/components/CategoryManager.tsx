import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Field } from './ui';
import { errText, useToast } from '../state';

interface Response {
  defaults: string[];
  custom: Array<{ id: number; name: string }>;
}

export function CategoryManager() {
  const { toast } = useToast();
  const [data, setData] = useState<Response | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.get<Response>('/finance/categories')); }
    catch (e) { toast('err', errText(e)); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return toast('err', 'Enter a category name');
    setBusy(true);
    try {
      await api.post('/finance/categories', { name: name.trim() });
      setName('');
      await load();
      toast('ok', `Added ${name.trim()}`);
    } catch (err) { toast('err', errText(err)); }
    finally { setBusy(false); }
  }

  async function remove(id: number) {
    if (!confirm('Remove this custom category? Existing expenses keep the label.')) return;
    setRemoving(id);
    try {
      await api.del(`/finance/categories/${id}`);
      await load();
    } catch (err) { toast('err', errText(err)); }
    finally { setRemoving(null); }
  }

  if (!data) return null;

  return (
    <Card>
      <h2>🏷️ Expense categories</h2>
      <p className="muted small">
        The 10 built-in categories are always available. Add your own for things like "Pets", "Rent split", or "Gym".
      </p>
      <div className="row wrap" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
        {data.defaults.map((d) => (
          <span key={d} className="pill info">{d}</span>
        ))}
        <AnimatePresence>
          {data.custom.map((c) => (
            <motion.span
              key={c.id}
              layout
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="pill"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {c.name}
              <button
                onClick={() => void remove(c.id)}
                className="icon-btn"
                aria-label={`Remove ${c.name}`}
                disabled={removing === c.id}
                style={{ fontSize: '0.75rem', padding: '0 2px' }}
              >
                {removing === c.id ? '…' : '✕'}
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
      </div>
      <form onSubmit={add} className="row-sm" style={{ gap: '0.5rem', marginTop: '0.8rem' }}>
        <Field label="New category">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            placeholder="Pets, Gifts, Gym…"
          />
        </Field>
        <button className="btn" type="submit" disabled={busy} style={{ alignSelf: 'end' }}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
    </Card>
  );
}
