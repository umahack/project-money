import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card } from './ui';
import { errText, useToast } from '../state';

interface SessionRow {
  id: number;
  device_label: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  revoked: boolean;
}

interface SessionsResponse {
  current_sid: number;
  sessions: SessionRow[];
}

export function DevicesPanel() {
  const { toast } = useToast();
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [busy, setBusy] = useState<number | 'all' | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<SessionsResponse>('/auth/sessions'));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  async function revoke(id: number) {
    if (!confirm('Sign out this device?')) return;
    setBusy(id);
    try {
      await api.del(`/auth/sessions/${id}`);
      await load();
      toast('ok', 'Device signed out');
    } catch (e) { toast('err', errText(e)); }
    finally { setBusy(null); }
  }

  async function revokeOthers() {
    if (!confirm('Sign out of every other device?')) return;
    setBusy('all');
    try {
      await api.del('/auth/sessions');
      await load();
      toast('ok', 'All other devices signed out');
    } catch (e) { toast('err', errText(e)); }
    finally { setBusy(null); }
  }

  if (!data) return null;

  const active = data.sessions.filter((s) => !s.revoked);
  const recentlyRevoked = data.sessions.filter((s) => s.revoked);

  return (
    <Card>
      <h2>📱 Devices</h2>
      <p className="muted small">
        Only one device can be signed in at a time. Signing in elsewhere automatically
        signs out this device. Admins can't sign you out of your own account.
      </p>

      <h3 style={{ marginTop: '0.6rem' }}>Active ({active.length})</h3>
      <ul className="list">
        <AnimatePresence>
          {active.map((s) => (
            <motion.li
              key={s.id}
              className="list-item"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -16 }}
              layout
            >
              <span className="avatar">💻</span>
              <div className="grow">
                <strong>
                  {s.device_label || 'Unknown device'}
                  {s.id === data.current_sid && <span className="pill info" style={{ marginLeft: 6 }}>This device</span>}
                </strong>
                <small className="muted">
                  signed in {s.created_at}
                  {s.last_seen_at ? ` · last active ${s.last_seen_at}` : ''}
                </small>
              </div>
              {s.id !== data.current_sid && (
                <button className="btn sm ghost" disabled={busy === s.id} onClick={() => void revoke(s.id)}>
                  {busy === s.id ? '…' : 'Sign out'}
                </button>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      {active.length > 1 && (
        <button className="btn ghost sm" style={{ marginTop: '0.4rem' }} disabled={busy === 'all'} onClick={() => void revokeOthers()}>
          {busy === 'all' ? 'Signing out…' : 'Sign out every other device'}
        </button>
      )}

      {recentlyRevoked.length > 0 && (
        <>
          <h3 style={{ marginTop: '1rem' }}>Recent sign-outs</h3>
          <ul className="list">
            {recentlyRevoked.slice(0, 8).map((s) => (
              <li key={s.id} className="list-item muted">
                <span className="avatar">💤</span>
                <div className="grow">
                  <strong>{s.device_label || 'Unknown device'}</strong>
                  <small className="muted">
                    {s.revoked_reason === 'another_device' ? 'Replaced by a newer sign-in' : (s.revoked_reason || 'signed out')} · {s.revoked_at}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
