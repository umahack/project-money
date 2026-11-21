import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearAuth } from '../api';
import { Card, Field } from './ui';
import { useAuth, useToast } from '../state';

interface RecordCategory {
  key: string;
  description: string;
}

interface AccountControlFailurePayload {
  error?: string;
  code?: string;
  status?: string;
  failed_record_categories?: unknown;
  undeleted_record_categories?: unknown;
  support?: {
    email?: string;
    path?: string;
  };
}

interface FailureState {
  message: string;
  categories: RecordCategory[];
  supportEmail: string;
  supportPath: string;
}

const DEFAULT_SUPPORT_EMAIL = 'hello@project-money.online';
const DEFAULT_SUPPORT_PATH = `mailto:${DEFAULT_SUPPORT_EMAIL}`;

function apiBase(): string {
  return ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
}

async function readFailurePayload(response: Response): Promise<AccountControlFailurePayload> {
  try {
    return await response.json() as AccountControlFailurePayload;
  } catch {
    return {};
  }
}

function recordCategories(value: unknown): RecordCategory[] {
  if (!Array.isArray(value)) return [];
  return value.filter((category): category is RecordCategory => {
    if (!category || typeof category !== 'object') return false;
    const candidate = category as Partial<RecordCategory>;
    return typeof candidate.key === 'string' && typeof candidate.description === 'string';
  });
}

function supportContact(payload: AccountControlFailurePayload) {
  const email = payload.support?.email?.trim() ?? '';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { supportEmail: email, supportPath: `mailto:${email}` };
  }
  return { supportEmail: DEFAULT_SUPPORT_EMAIL, supportPath: DEFAULT_SUPPORT_PATH };
}

function categoryLabel(key: string): string {
  const words = key.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Last-stop account controls: full-account JSON export and permanent delete.
 * Both are read/write against /auth; delete requires currentPassword confirm.
 */
export function DangerZone() {
  const { toast } = useToast();
  const { logout } = useAuth();
  const nav = useNavigate();
  const [exportBusy, setExportBusy] = useState(false);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [error, setError] = useState('');
  const [exportFailure, setExportFailure] = useState<FailureState | null>(null);
  const [deletionFailure, setDeletionFailure] = useState<FailureState | null>(null);

  const working = exportBusy || deletionBusy;

  function expireSession(message: string) {
    clearAuth();
    window.dispatchEvent(new CustomEvent('auth:expired', { detail: message }));
  }

  async function exportJson() {
    setExportBusy(true);
    setExportFailure(null);
    try {
      const token = sessionStorage.getItem('pm_token') ?? '';
      const res = await fetch(`${apiBase()}/api/auth/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const payload = await readFailurePayload(res);
        if (res.status === 401) {
          expireSession(payload.error || 'Your session has ended. Please sign in again.');
          return;
        }

        const support = supportContact(payload);
        const failure = {
          message: payload.error || 'Account export was unsuccessful. Your records are unchanged.',
          categories: recordCategories(payload.failed_record_categories),
          ...support,
        };
        setExportFailure(failure);
        toast('err', failure.message);
        return;
      }

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
    } catch {
      const failure = {
        message: 'Account export was unsuccessful. Your records are unchanged.',
        categories: [],
        supportEmail: DEFAULT_SUPPORT_EMAIL,
        supportPath: DEFAULT_SUPPORT_PATH,
      };
      setExportFailure(failure);
      toast('err', failure.message);
    } finally {
      setExportBusy(false);
    }
  }

  async function deleteAccount() {
    setError('');
    if (!password) return setError('Enter your current password to confirm.');
    if (confirmWord.trim().toLowerCase() !== 'delete') return setError('Type DELETE to confirm.');

    setDeletionBusy(true);
    setDeletionFailure(null);
    try {
      const token = sessionStorage.getItem('pm_token') ?? '';
      const res = await fetch(`${apiBase()}/api/auth/account`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword: password }),
      });
      const payload = await readFailurePayload(res);

      if (!res.ok) {
        if (payload.code === 'ACCOUNT_DELETION_INCOMPLETE') {
          const support = supportContact(payload);
          setDeletionFailure({
            message: payload.error || 'Account deletion is incomplete. No account records were deleted.',
            categories: recordCategories(payload.undeleted_record_categories),
            ...support,
          });
          return;
        }
        if (res.status === 401 && !/password is incorrect/i.test(payload.error ?? '')) {
          expireSession(payload.error || 'Your session has ended. Please sign in again.');
          return;
        }
        setError(payload.error || `Delete failed (${res.status}).`);
        return;
      }

      toast('ok', 'Account deleted. Sorry to see you go.');
      clearAuth();
      logout();
      nav('/login', { replace: true });
    } catch {
      setError('Delete failed because the server could not be reached. Check your account before retrying.');
    } finally {
      setDeletionBusy(false);
    }
  }

  function closeDeletion() {
    setOpen(false);
    setPassword('');
    setConfirmWord('');
    setError('');
    setDeletionFailure(null);
  }

  return (
    <Card>
      <h2>⚠️ Account controls</h2>
      <p className="muted small">
        Download everything we have on your account, or permanently delete the account and
        every row we've stored for you. Deletion cannot be undone.
      </p>
      <div className="row wrap" style={{ gap: '0.6rem', marginTop: '0.4rem' }}>
        <button className="btn ghost" onClick={() => void exportJson()} disabled={working}>
          {exportBusy ? 'Preparing export…' : '📥 Download my data (JSON)'}
        </button>
        {!open ? (
          <button className="btn danger-solid" onClick={() => setOpen(true)} disabled={working}>
            🗑️ Delete my account
          </button>
        ) : (
          <button className="btn ghost" onClick={closeDeletion} disabled={deletionBusy}>
            Cancel
          </button>
        )}
      </div>

      {exportFailure && (
        <section
          role="alert"
          aria-live="assertive"
          aria-labelledby="account-export-failure-title"
          style={{ marginTop: '0.8rem', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', padding: '0.8rem' }}
        >
          <h3 id="account-export-failure-title" style={{ marginTop: 0 }}>Export unsuccessful</h3>
          <p className="small">{exportFailure.message}</p>
          {exportFailure.categories.length > 0 && (
            <ul className="small">
              {exportFailure.categories.map((category) => (
                <li key={category.key}>
                  <strong>{categoryLabel(category.key)}:</strong> {category.description}
                </li>
              ))}
            </ul>
          )}
          <div className="row wrap" style={{ gap: '0.6rem' }}>
            <button className="btn ghost" onClick={() => void exportJson()} disabled={working}>
              {exportBusy ? 'Retrying export…' : 'Retry export'}
            </button>
            <a className="btn ghost" href={exportFailure.supportPath}>
              Contact support at {exportFailure.supportEmail}
            </a>
          </div>
        </section>
      )}

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
          {deletionFailure ? (
            <section
              role="alert"
              aria-live="assertive"
              aria-labelledby="account-deletion-failure-title"
              style={{ marginTop: '0.8rem', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', padding: '0.8rem' }}
            >
              <h3 id="account-deletion-failure-title" style={{ marginTop: 0 }}>Account deletion incomplete</h3>
              <p className="small">{deletionFailure.message}</p>
              <p className="small"><strong>Your account is still active, and your records remain unchanged.</strong></p>
              {deletionFailure.categories.length > 0 && (
                <>
                  <p className="small">The following record categories were not deleted:</p>
                  <ul className="small">
                    {deletionFailure.categories.map((category) => (
                      <li key={category.key}>
                        <strong>{categoryLabel(category.key)}:</strong> {category.description}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="row wrap" style={{ gap: '0.6rem' }}>
                <button className="btn danger-solid" onClick={() => void deleteAccount()} disabled={working}>
                  {deletionBusy ? 'Retrying deletion…' : 'Retry account deletion'}
                </button>
                <a className="btn ghost" href={deletionFailure.supportPath}>
                  Contact support at {deletionFailure.supportEmail}
                </a>
              </div>
            </section>
          ) : (
            <button
              className="btn danger-solid"
              onClick={() => void deleteAccount()}
              disabled={working}
            >
              {deletionBusy ? 'Deleting…' : 'Permanently delete my account'}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
