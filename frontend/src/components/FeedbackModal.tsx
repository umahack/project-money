import { useState } from 'react';
import { api } from '../api';
import { errText } from '../state';
import { Modal } from './ui';

const LABELS = ['Terrible', 'Poor', 'Okay', 'Good', 'Great'];

/**
 * Shown when the user presses Sign out. "Send & sign out" posts the rating, "Skip & sign out" just leaves,
 * and closing the dialog (✕, Esc, backdrop) keeps the user signed in.
 */
export function FeedbackModal({ open, onCancel, onDone }: { open: boolean; onCancel: () => void; onDone: () => void }) {
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
      await api.post('/feedback', { rating, message: message.trim() || undefined });
      try {
        localStorage.setItem('pm_feedback_thanks', '1');
      } catch {
        /* storage may be blocked; the thank-you toast is optional */
      }
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onCancel} title="Feedback" locked={loading}>
      <button className="modal-x" onClick={onCancel} aria-label="Close and stay signed in" disabled={loading}>✕</button>
      <h2>Before you go, how was it?</h2>
      <p className="muted">Your feedback shapes what gets built next. It takes 10 seconds.</p>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => {
          const active = (hover || rating) >= n;
          return (
            <button
              key={n}
              type="button"
              className={`star ${active ? 'on' : ''}`}
              onClick={() => setRating(n)}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
            >
              ★
            </button>
          );
        })}
        <span className="muted small">{rating ? LABELS[rating - 1] : 'Pick a rating'}</span>
      </div>
      <label className="field">
        <span>Message (optional)</span>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} placeholder="What worked? What should we fix?" rows={4} />
        <small className="muted right">{message.length}/2000</small>
      </label>
      {err && <p className="form-error" role="alert">{err}</p>}
      <div className="row end wrap">
        <button className="btn ghost" onClick={onDone} disabled={loading}>Skip &amp; sign out</button>
        <button className="btn primary" onClick={() => void submit()} disabled={loading}>{loading ? 'Sending…' : 'Send & sign out'}</button>
      </div>
    </Modal>
  );
}
