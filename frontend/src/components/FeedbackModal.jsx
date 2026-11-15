import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api/client.js';

export default function FeedbackModal({ open, onClose, onSubmitted }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [message, setMessage] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setErr('');
    if (rating < 1) return setErr('Please pick a rating from 1 to 5 stars.');
    setLoading(true);
    try {
      await api('/feedback', { method: 'POST', body: { rating, message } });
      try {
        localStorage.setItem('pm_feedback_thanks', '1');
      } catch {}
      onSubmitted?.();
    } catch (e) {
      setErr(e.message || 'Could not submit. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <motion.div
            initial={{ scale: 0.9, y: 20, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 20, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="card w-full max-w-md relative"
            role="dialog"
            aria-modal="true"
          >
            <button
              onClick={onClose}
              className="absolute top-3 right-3 text-white/70 hover:text-white"
              aria-label="Close"
            >
              ✕
            </button>
            <h2 className="text-xl font-bold text-white">Before you go — how was it?</h2>
            <p className="text-white/80 text-sm mt-1">
              Your feedback shapes what we build next. Takes 10 seconds.
            </p>

            <div className="flex items-center gap-1 mt-5" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => {
                const active = (hover || rating) >= n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHover(n)}
                    onMouseLeave={() => setHover(0)}
                    className={`text-3xl transition-transform ${active ? 'scale-110' : 'scale-100'}`}
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  >
                    <span className={active ? 'text-amber' : 'text-white/30'}>★</span>
                  </button>
                );
              })}
              <span className="ml-2 text-white/70 text-sm">
                {rating ? ['Terrible', 'Poor', 'Okay', 'Good', 'Great'][rating - 1] : 'Pick a rating'}
              </span>
            </div>

            <label className="label mt-4">Message (optional)</label>
            <textarea
              className="input min-h-[90px] resize-y"
              placeholder="What worked? What should we fix?"
              maxLength={2000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="text-xs text-white/60 mt-1 text-right">{message.length}/2000</div>

            {err && (
              <div role="alert" className="mt-3 text-sm text-rose-200 bg-rose-500/10 border border-rose-400/30 rounded-xl p-3">
                {err}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button className="btn-ghost" onClick={onClose} disabled={loading}>Skip</button>
              <button className="btn-primary" onClick={submit} disabled={loading}>
                {loading ? 'Sending…' : 'Send & log out'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
