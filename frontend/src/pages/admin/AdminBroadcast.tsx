import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../api';
import { Card, ConfirmDialog, Empty, Field, PageTitle, Spinner, type ConfirmState } from '../../components/ui';
import { fmtDate } from '../../money';
import { errText, useAuth, useToast } from '../../state';

interface Row {
  id: number;
  message: string;
  kind: 'info' | 'warn' | 'ok';
  is_active: boolean;
  created_at: string;
  actor_email: string | null;
}

export function AdminBroadcast() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<'info' | 'warn' | 'ok'>('info');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ announcements: Row[] }>('/admin/announcements');
      setRows(r.announcements);
    } catch (e) { toast('err', errText(e)); }
  }, [toast]);

  useEffect(() => {
    if (me?.is_admin) void load();
  }, [load, me?.is_admin]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) return toast('err', 'Enter a message');
    setBusy(true);
    try {
      await api.post('/admin/announcements', { message: message.trim(), kind });
      setMessage('');
      await load();
      toast('ok', 'Announcement live');
    } catch (err) { toast('err', errText(err)); }
    finally { setBusy(false); }
  }

  async function toggle(r: Row) {
    try {
      await api.put(`/admin/announcements/${r.id}/active`, { is_active: !r.is_active });
      await load();
    } catch (err) { toast('err', errText(err)); }
  }

  async function remove(id: number) {
    try {
      await api.del(`/admin/announcements/${id}`);
      await load();
      toast('ok', 'Removed');
    } catch (err) { toast('err', errText(err)); }
  }

  if (!me?.is_admin) return <Card><Empty emoji="🔒" title="Admins only" /></Card>;
  if (!rows) return <Spinner />;

  return (
    <>
      <PageTitle title="Broadcast 📢" sub="Post a short banner that every signed-in user sees at the top of the app." />

      <Card>
        <h2>Post an announcement</h2>
        <form onSubmit={create} className="stack-sm">
          <Field label="Message" hint="Up to 240 characters. Shown to every visitor until you deactivate or delete it.">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={240}
              placeholder="Scheduled maintenance Sunday 9 PM IST — expect ~5 min downtime."
              rows={3}
            />
          </Field>
          <Field label="Tone">
            <select value={kind} onChange={(e) => setKind(e.target.value as 'info' | 'warn' | 'ok')}>
              <option value="info">📢 Info (purple)</option>
              <option value="warn">⚠️ Warn (amber)</option>
              <option value="ok">✅ Good news (green)</option>
            </select>
          </Field>
          <button className="btn primary" type="submit" disabled={busy || !message.trim()}>
            {busy ? 'Posting…' : 'Post banner'}
          </button>
        </form>
      </Card>

      <Card>
        <h2>History</h2>
        {rows.length === 0 ? (
          <Empty emoji="📭" title="Nothing posted yet" />
        ) : (
          <ul className="list">
            <AnimatePresence>
              {rows.map((r) => (
                <motion.li
                  key={r.id}
                  className="list-item top"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  layout
                >
                  <span className="avatar">{r.kind === 'warn' ? '⚠️' : r.kind === 'ok' ? '✅' : '📢'}</span>
                  <div className="grow">
                    <strong>{r.message}</strong>
                    <small className="muted">
                      {r.is_active ? 'LIVE · ' : 'archived · '}
                      {r.actor_email ?? 'unknown'} · {fmtDate(r.created_at, true)}
                    </small>
                  </div>
                  <button className="btn ghost sm" onClick={() => void toggle(r)}>
                    {r.is_active ? 'Deactivate' : 'Re-activate'}
                  </button>
                  <button
                    className="btn ghost sm danger"
                    onClick={() =>
                      setConfirm({
                        title: 'Delete this announcement?',
                        text: 'It will stop showing immediately.',
                        confirmLabel: 'Delete',
                        danger: true,
                        onConfirm: () => remove(r.id),
                      })
                    }
                  >
                    Delete
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
