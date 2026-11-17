import { useEffect, useState } from 'react';
import { api } from '../api';
import { errText } from '../state';
import { Modal } from './ui';

const LABELS = ['Terrible', 'Poor', 'Okay', 'Good', 'Great'];
const MIN_MESSAGE_LEN = 10;

/**
 * Sign-out gate. Feedback is MANDATORY for first-time users (stars + a short
 * message). Users who have already left feedback once get a Skip button so
 * repeat sign-outs aren't annoying. The ✕ / Esc / backdrop always keeps the
 * user signed in — this modal only ever ends in "sign out" via a button.
 */
export function FeedbackModal({ open, onCancel, onDone }: { open: boolean; onCancel: () => void; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [message, setMessage] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [priorCount, setPriorCount] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset form each time the modal opens, then fetch whether the user has
    // ever submitted feedback — only prior-feedback users can skip.
    setRating(0);
    setHover(0);
    setMessage('');
    setErr('');
    setPriorCount(null);
    api.get<{ count: number }>('/feedback/mine')
      .then((r) => setPriorCount(Number(r.count ?? 0)))
      .catch(() => setPriorCount(0));
  }, [open]);

  const canSkip = (priorCount ?? 0) > 0;
  const trimmed = message.trim();
  const meetsRequired = rating >= 1 && trimmed.length >= MIN_MESSAGE_LEN;

  async function submit() {
    setErr('');
    if (rating < 1) return setErr('Please pick a rating from 1 to 5 stars.');
    if (trimmed.length < MIN_MESSAGE_LEN) {
      return setErr(`Please add at least ${MIN_MESSAGE_LEN} characters so we know what to improve.`);
    }
    setLoading(true);
    try {
      await api.post('/feedback', { rating, message: trimmed });
      try { localStorage.setItem('pm_feedback_thanks', '1'); } catch { /* ignore */ }
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onCancel} title="Before you go" locked={loading}>
      <button className="modal-x" onClick={onCancel} aria-label="Close and stay signed in" disabled={loading}>✕</button>
      <h2>How was it?</h2>
      {priorCount === null ? (
        <p className="muted">Loading…</p>
      ) : canSkip ? (
        <p className="muted">Thanks for your earlier feedback. You can leave more below, or skip and sign out.</p>
      ) : (
        <p className="muted">
          A quick rating + a line about your experience is required before signing out —
          this is a beta and your feedback shapes what gets built next. Takes 15 seconds.
        </p>
      )}

      <div className="stars" role="radiogroup" aria-label="Rating (required)">
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
        <span className="muted small">
          {rating ? LABELS[rating - 1] : canSkip ? 'Pick a rating (optional)' : 'Pick a rating · required'}
        </span>
      </div>

      <label className="field">
        <span>
          Your message
          {!canSkip && <span className="muted small"> · required · min {MIN_MESSAGE_LEN} chars</span>}
        </span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={2000}
          placeholder={canSkip
            ? 'Anything new to share?'
            : 'What worked? What should we fix? Any feature you wish we had?'}
          rows={4}
        />
        <small className="muted right">
          {!canSkip && trimmed.length < MIN_MESSAGE_LEN
            ? `${trimmed.length}/${MIN_MESSAGE_LEN} min · ${message.length}/2000`
            : `${message.length}/2000`}
        </small>
      </label>

      {err && <p className="form-error" role="alert">{err}</p>}

      <div className="row end wrap">
        {canSkip && (
          <button className="btn ghost" onClick={onDone} disabled={loading}>
            Skip &amp; sign out
          </button>
        )}
        <button
          className="btn primary"
          onClick={() => void submit()}
          disabled={loading || priorCount === null || (!canSkip && !meetsRequired)}
          title={!canSkip && !meetsRequired ? 'Pick a rating and add a short message to continue.' : undefined}
        >
          {loading ? 'Sending…' : 'Send & sign out'}
        </button>
      </div>
    </Modal>
  );
}
