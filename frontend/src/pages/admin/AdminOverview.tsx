import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../../api';
import { Card, Empty, PageTitle, Spinner } from '../../components/ui';
import { inr } from '../../money';
import { errText, useAuth, useToast } from '../../state';
import type { AdminStats } from '../../types';

export function AdminOverview() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setStats(await api.get<AdminStats>('/admin/stats'));
    } catch (e) { toast('err', errText(e)); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => {
    if (me?.is_admin) void load();
    else setLoading(false);
  }, [load, me?.is_admin]);

  if (!me?.is_admin)
    return <Card><Empty emoji="🔒" title="Admins only" text="Your account does not have admin access." /></Card>;
  if (loading) return <Spinner />;

  return (
    <>
      <PageTitle title="Admin 🛡️" sub="Jump to the section you need. All destructive actions are audited." />
      {stats && (
        <div className="grid stats8">
          <Stat label="Users" value={String(stats.users)} />
          <Stat label="Admins" value={String(stats.admins)} />
          <Stat label="Trips" value={String(stats.trips)} />
          <Stat label="EMIs" value={String(stats.emis)} />
          <Stat label="Total income" value={inr(stats.total_income)} />
          <Stat label="Total EMI" value={inr(stats.total_emi)} />
          <Stat label="Feedback" value={String(stats.feedback_count ?? 0)} />
          <Stat label="Avg rating" value={stats.avg_rating ? `${stats.avg_rating} ★` : '—'} />
        </div>
      )}

      <div className="grid admin-cards">
        <Link to="/admin/users" className="admin-card">
          <h3>👥 Users</h3>
          <p className="muted small">Search, override salaries, promote / demote, reset passwords, delete.</p>
        </Link>
        <Link to="/admin/feedback" className="admin-card">
          <h3>⭐ Feedback</h3>
          <p className="muted small">User ratings and messages. Delete entries you no longer need.</p>
        </Link>
        <Link to="/admin/traffic" className="admin-card">
          <h3>👀 Traffic & audit</h3>
          <p className="muted small">Daily visitor counts + append-only log of privileged actions.</p>
        </Link>
        <Link to="/admin/broadcast" className="admin-card">
          <h3>📢 Broadcast</h3>
          <p className="muted small">Post a short banner that every signed-in user sees at the top of the app.</p>
        </Link>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <motion.div whileHover={{ y: -3 }} className="stat-tile">
      <span className="muted">{label}</span>
      <strong className="mono">{value}</strong>
    </motion.div>
  );
}
