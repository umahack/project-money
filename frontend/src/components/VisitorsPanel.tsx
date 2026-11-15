import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card } from './ui';
import { errText, useToast } from '../state';

interface VisitStats {
  total: number;
  unique_visitors: number;
  today_visits: number;
  today_visitors: number;
  per_day: Array<{ day: string; visits: number; visitors: number }>;
  top_paths: Array<{ path: string; count: number }>;
  latest: Array<{
    path: string;
    user_agent: string | null;
    created_at: string;
    email: string | null;
    name: string | null;
  }>;
}

const shortDay = (d: string) => d.slice(5); // MM-DD

export function VisitorsPanel() {
  const { toast } = useToast();
  const [s, setS] = useState<VisitStats | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await api.get<VisitStats>('/admin/visits/stats'));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!s) return null;

  const max = Math.max(1, ...s.per_day.map((d) => d.visits));

  return (
    <Card>
      <h2>👀 Visitors</h2>
      <p className="muted small">Per-day page views. Uniques count distinct daily IP hashes — no raw IPs stored.</p>

      <div className="stat-row">
        <div><span className="muted">Total views</span><b className="big">{s.total}</b></div>
        <div><span className="muted">Unique visitors</span><b className="big">{s.unique_visitors}</b></div>
        <div><span className="muted">Today views</span><b className="big">{s.today_visits}</b></div>
        <div><span className="muted">Today visitors</span><b className="big">{s.today_visitors}</b></div>
      </div>

      {s.per_day.length > 0 && (
        <div className="history-chart" aria-label="Visits per day">
          {s.per_day.map((d) => (
            <div key={d.day} className="hc-col" title={`${d.day}: ${d.visits} views / ${d.visitors} unique`}>
              <div className="hc-bar-wrap">
                <motion.div
                  className="hc-bar"
                  initial={{ height: 0 }}
                  animate={{ height: `${Math.max(2, Math.round((d.visits / max) * 100))}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                  style={{ background: 'linear-gradient(180deg, #7c6cff, #4ade80)' }}
                />
              </div>
              <small className="hc-label">{shortDay(d.day)}</small>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: '1rem' }}>Top pages</h3>
      {s.top_paths.length ? (
        <ul className="list">
          {s.top_paths.map((p) => (
            <li key={p.path} className="list-item">
              <code style={{ background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: 4 }}>{p.path}</code>
              <div className="grow" />
              <b className="mono">{p.count}</b>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No traffic yet.</p>}

      <h3 style={{ marginTop: '1rem' }}>Latest 25 views</h3>
      {s.latest.length ? (
        <ul className="list">
          {s.latest.map((v, i) => (
            <li key={i} className="list-item">
              <span className="avatar">{v.email ? v.email.slice(0, 1).toUpperCase() : '?'}</span>
              <div className="grow">
                <strong>{v.path}</strong>
                <small className="muted">
                  {v.email ? `${v.email}` : 'anonymous'} · {v.created_at}
                  {v.user_agent ? ` · ${v.user_agent.split(/[()]/)[0].slice(0, 40)}` : ''}
                </small>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No visits yet.</p>}
    </Card>
  );
}
