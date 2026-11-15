import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Card, ConfirmDialog, Empty, PageTitle, Spinner, type ConfirmState } from '../../components/ui';
import { fmtDate } from '../../money';
import { errText, useAuth, useToast } from '../../state';
import type { FeedbackRow } from '../../types';

export function AdminFeedback() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const load = useCallback(async () => {
    try {
      const f = await api.get<{ feedback: FeedbackRow[] }>('/admin/feedback');
      setFeedback(f.feedback);
    } catch (e) { toast('err', errText(e)); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => {
    if (me?.is_admin) void load();
    else setLoading(false);
  }, [load, me?.is_admin]);

  async function act(fn: () => Promise<unknown>, okMsg: string) {
    try { await fn(); toast('ok', okMsg); await load(); }
    catch (e) { toast('err', errText(e)); }
  }

  if (!me?.is_admin) return <Card><Empty emoji="🔒" title="Admins only" /></Card>;
  if (loading) return <Spinner />;

  return (
    <>
      <PageTitle title="Feedback ⭐" sub="Latest ratings and messages from users. Deletions are logged." />
      <Card>
        {feedback.length ? (
          <ul className="list">
            {feedback.map((f) => (
              <li key={f.id} className="list-item top">
                <div className="grow">
                  <div className="row wrap">
                    <span className="stars-static" aria-label={`${f.rating} out of 5`}>{'★'.repeat(f.rating)}<span className="dim">{'★'.repeat(5 - f.rating)}</span></span>
                    <span className="muted small">{f.email || 'anonymous'} · {fmtDate(f.created_at, true)}</span>
                  </div>
                  {f.message && <p className="fb-msg">{f.message}</p>}
                </div>
                <button
                  className="icon-btn danger"
                  aria-label="Delete feedback"
                  onClick={() => setConfirm({ title: 'Delete this feedback?', text: 'This entry will be removed for good.', confirmLabel: 'Delete', danger: true, onConfirm: () => act(() => api.del(`/admin/feedback/${f.id}`), 'Feedback deleted') })}
                >🗑️</button>
              </li>
            ))}
          </ul>
        ) : <Empty emoji="💬" title="No feedback yet" />}
      </Card>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
