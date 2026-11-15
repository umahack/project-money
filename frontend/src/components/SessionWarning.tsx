import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, setAuth } from '../api';
import type { User } from '../types';
import { useSessionWarning } from '../hooks/useSessionWarning';
import { errText, useToast } from '../state';

export function SessionWarning() {
  const show = useSessionWarning(5 * 60 * 1000); // 5 min before expiry
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function stay() {
    setBusy(true);
    try {
      const r = await api.post<{ token: string; user: User }>('/auth/refresh', {});
      setAuth(r.token, r.user);
      toast('ok', 'Signed in for another 30 minutes');
    } catch (e) {
      toast('err', errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="session-banner"
          role="status"
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -24, opacity: 0 }}
        >
          <span>⏱️ Your session ends in ~5 minutes.</span>
          <button className="btn primary sm" onClick={() => void stay()} disabled={busy}>
            {busy ? 'Refreshing…' : 'Stay signed in'}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
