import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface Announcement {
  id: number;
  message: string;
  kind: 'info' | 'warn' | 'ok';
}

const STORAGE_PREFIX = 'pm_dismissed_announcement_';

/**
 * Reads the latest active announcement (if any), caches dismissals per-id so
 * the user can hide the current message but still see future ones.
 */
export function AnnouncementBanner() {
  const [item, setItem] = useState<Announcement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
        const res = await fetch(`${base}/api/public/announcement`);
        if (!res.ok) return;
        const data = (await res.json()) as { announcement: Announcement | null };
        if (cancelled) return;
        if (!data.announcement) { setItem(null); return; }
        const dismissed = sessionStorage.getItem(STORAGE_PREFIX + data.announcement.id);
        setItem(dismissed ? null : data.announcement);
      } catch { /* best-effort */ }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  function dismiss() {
    if (!item) return;
    try { sessionStorage.setItem(STORAGE_PREFIX + item.id, '1'); } catch { /* ignore */ }
    setItem(null);
  }

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          className={`announce-banner ${item.kind}`}
          role="status"
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -24, opacity: 0 }}
        >
          <span className="announce-icon">{item.kind === 'warn' ? '⚠️' : item.kind === 'ok' ? '✅' : '📢'}</span>
          <span className="grow">{item.message}</span>
          <button className="icon-btn" onClick={dismiss} aria-label="Dismiss">✕</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
