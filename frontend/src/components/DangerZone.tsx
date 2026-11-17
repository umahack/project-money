import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearAuth } from '../api';
import { Card, Field } from './ui';
import { errText, useAuth, useToast } from '../state';

/**
 * Last-stop account controls: full-account JSON export and permanent delete.
 * Both are read/write against /auth; delete requires currentPassword confirm.
 */
export function DangerZone() {
  const { toast } = useToast();
  const { logout } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [error, setError] = useState('');

  async function exportJson() {
    setBusy(true);
    try {
      const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
      const token = sessionStorage.getItem('pm_token') ?? '';
      const res = await fetch(`${base}/api/auth/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        clearAuth();
        window.dispatchEvent(new CustomEvent('auth:expired', { detail: 'Your session has ended. Please sign in again.' }));
        return;
      }
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-money-account-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('ok', 'Account data downloaded');
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setError('');
    if (!password) return setError('Enter your current password to confirm.');
    if (confirmWord.trim().toLowerCase() !== 'delete') return setError('Type DELETE to confirm.');
    setBusy(true);
    try {
      await api.del('/auth/account', { currentPassword: password });
      toast('ok', 'Account deleted. Sorry to see you go.');
      clearAuth();
      logout();
      nav('/login', { replace: true });
    } catch (err) {
      setError(errText(err) || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2>⚠️ Account controls</h2>
      <p className="muted small">
        Download everything we have on your account, or permanently delete the account and
        every row we've stored for you. Deletion cannot be undone.
      </p>
      <div className="row wrap" style={{ gap: '0.6rem', marginTop: '0.4rem' }}>
        <button className="btn ghost" onClick={() => void exportJson()} disabled={busy}>
          {busy ? 'Working…' : '📥 Download my data (JSON)'}
        </button>
        {!open ? (
          <button className="btn danger-solid" onClick={() => setOpen(true)} disabled={busy}>
            🗑️ Delete my account
          </button>
        ) : (
          <button className="btn ghost" onClick={() => { setOpen(false); setPassword(''); setConfirmWord(''); setError(''); }}>
            Cancel
          </button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: '0.8rem', borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <p className="muted small" style={{ marginTop: 0 }}>
            This will remove your salary data, expenses, EMIs, goals, recurring entries,
            categories, trips you own, trip memberships, device sessions, and your profile.
            It cannot be undone.
          </p>
          <Field label="Current password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label='Type "DELETE" to confirm'>
            <input
              type="text"
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="DELETE"
            />
          </Field>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button
            className="btn danger-solid"
            onClick={() => void deleteAccount()}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Permanently delete my account'}
          </button>
        </div>
      )}
    </Card>
  );
}
