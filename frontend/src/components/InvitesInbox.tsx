import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card } from './ui';
import { inr } from '../money';
import { errText, useAuth, useToast } from '../state';
import type { Invite } from '../types';

export function InvitesInbox({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const { toast } = useToast();
  const nav = useNavigate();
  const [items, setItems] = useState<Invite[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ invites: Invite[] }>('/invites');
      setItems(data.invites);
      onCountChange?.(data.invites.length);
    } catch (e) {
      toast('err', errText(e));
      setItems([]);
      onCountChange?.(0);
    }
  }, [toast, onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  async function respond(id: number, action: 'accept' | 'decline') {
    setBusy(id);
    try {
      const res = await api.post<{ ok: true; trip_id?: number }>(`/invites/${id}/${action}`, {});
      toast('ok', action === 'accept' ? 'Joined the trip!' : 'Invite declined');
      await load();
      if (action === 'accept' && res.trip_id) nav(`/trips/${res.trip_id}`);
    } catch (e) {
      toast('err', errText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!items) {
    return null;
  }
  if (items.length === 0) {
    return null;
  }

  return (
    <Card>
      <h2>✉️ Trip invites</h2>
      <ul className="list">
        <AnimatePresence>
          {items.map((inv) => (
            <motion.li
              key={inv.id}
              className="list-item"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -16 }}
              layout
            >
              <span className="avatar">{inv.inviter_name.slice(0, 1).toUpperCase()}</span>
              <div className="grow">
                <strong>{inv.trip_name}</strong>
                <small className="muted">
                  from {inv.inviter_name} ({inv.inviter_email})
                  {inv.destination ? ` · ${inv.destination}` : ''} · budget {inr(inv.budget)}
                </small>
              </div>
              <button className="btn sm" disabled={busy === inv.id} onClick={() => void respond(inv.id, 'accept')}>
                {busy === inv.id ? '…' : 'Accept'}
              </button>
              <button className="btn sm ghost" disabled={busy === inv.id} onClick={() => void respond(inv.id, 'decline')}>
                Decline
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Card>
  );
}

// Headless hook: just the pending count, for a nav badge.
export function usePendingInvitesCount() {
  const { user } = useAuth();
  const [count, setCount] = useState<number>(0);
  useEffect(() => {
    // Don't poll while signed out — spam of 401s is wasteful and can hide
    // legitimate 'auth:expired' signals.
    if (!user) {
      setCount(0);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const data = await api.get<{ invites: Invite[] }>('/invites');
        if (alive) setCount(data.invites.length);
      } catch {
        /* badge is best-effort; ignore errors */
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [user]);
  return count;
}

