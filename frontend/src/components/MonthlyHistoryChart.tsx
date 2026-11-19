import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card } from './ui';
import { inr } from '../money';
import { errText, useToast } from '../state';

interface HistoryBucket {
  month: string;
  total: number;
  byCategory: Record<string, number>;
}

interface HistoryResponse {
  months: HistoryBucket[];
}

const monthShort = (m: string) => {
  const parts = m.split('-');
  const mm = Number(parts[1]);
  if (!Number.isFinite(mm)) return m;
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mm - 1] ?? m;
};

export function MonthlyHistoryChart({ refreshKey = 0 }: { refreshKey?: number }) {
  const { toast } = useToast();
  const [data, setData] = useState<HistoryBucket[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<HistoryResponse>('/finance/history');
      setData(r.months);
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const max = useMemo(() => Math.max(1, ...(data?.map((b) => b.total) ?? [0])), [data]);
  const avg = useMemo(
    () => (data && data.length ? data.reduce((s, b) => s + b.total, 0) / data.length : 0),
    [data],
  );

  if (!data) return null;

  const hasAny = data.some((b) => b.total > 0);

  return (
    <Card>
      <h2>📈 Spending history (last 12 months)</h2>
      {!hasAny ? (
        <p className="muted small">Log a few expenses — your monthly trend shows up here.</p>
      ) : (
        <>
          <p className="small muted">
            Avg monthly spend: <b>{inr(avg)}</b>
          </p>
          <div className="history-chart" aria-label="Monthly spending bar chart">
            {data.map((b) => {
              const h = Math.round((b.total / max) * 100);
              return (
                <div key={b.month} className="hc-col" title={`${monthShort(b.month)}: ${inr(b.total)}`}>
                  <div className="hc-bar-wrap">
                    <motion.div
                      className="hc-bar"
                      initial={{ height: 0 }}
                      animate={{ height: `${Math.max(2, h)}%` }}
                      transition={{ duration: 0.6, ease: 'easeOut' }}
                      style={{ background: b.total > 0 ? 'linear-gradient(180deg, #7c6cff, #4ade80)' : 'rgba(255,255,255,0.08)' }}
                    />
                  </div>
                  <small className="hc-label">{monthShort(b.month)}</small>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
