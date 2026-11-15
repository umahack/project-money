import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card } from './ui';
import { errText, useToast } from '../state';

interface AuditRow {
  id: number;
  actor_id: number | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  details: string | null;
  created_at: string;
}

const ACTION_LABEL: Record<string, string> = {
  'admin.password_reset': '🔑 Admin reset password',
  'admin.user_delete': '🗑️ Admin deleted user',
  'admin.promote': '🛡️ Promoted to admin',
  'admin.demote': '🛡️ Demoted admin',
  'password.self_change': '🔑 User changed own password',
};

export function AuditLogPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<AuditRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ audit: AuditRow[] }>('/admin/audit');
      setRows(r.audit);
    } catch (e) { toast('err', errText(e)); }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!rows) return null;

  return (
    <Card>
      <h2>📓 Audit log</h2>
      <p className="muted small">Append-only record of privileged actions. Latest 200.</p>
      {rows.length ? (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id} className="list-item">
              <span className="avatar">{r.actor_email ? r.actor_email.slice(0, 1).toUpperCase() : '?'}</span>
              <div className="grow">
                <strong>{ACTION_LABEL[r.action] ?? r.action}</strong>
                <small className="muted">
                  {r.actor_email ?? 'unknown actor'}
                  {r.target ? ` · ${r.target}` : ''}
                  {' · '}{r.created_at}
                </small>
                {r.details && <small className="muted" style={{ display: 'block' }}>{r.details}</small>}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">Nothing audited yet.</p>}
    </Card>
  );
}
