import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card } from './ui';
import { errText, useToast } from '../state';

interface InsightItem {
  id: string;
  kind: 'ok' | 'warn' | 'info';
  title: string;
  text: string;
}

interface Response {
  thisMonth: string;
  prevMonth: string;
  totals: { thisMonth: number; prevMonth: number };
  weekdayAvg: Array<{ day: string; avg: number }>;
  insights: InsightItem[];
}

const KIND_STYLE: Record<InsightItem['kind'], { emoji: string; cls: string }> = {
  ok: { emoji: '✅', cls: 'pill ok' },
  warn: { emoji: '⚠️', cls: 'pill warn' },
  info: { emoji: '💡', cls: 'pill info' },
};

export function SmartInsights({ refreshKey = 0 }: { refreshKey?: number }) {
  const { toast } = useToast();
  const [data, setData] = useState<Response | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Response>('/finance/insights'));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!data) return null;

  return (
    <Card>
      <h2>🧠 Smart insights</h2>
      <ul className="list">
        <AnimatePresence>
          {data.insights.map((i) => (
            <motion.li
              key={i.id}
              className="list-item"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -16 }}
              layout
              style={{ alignItems: 'flex-start' }}
            >
              <span className={KIND_STYLE[i.kind].cls}>{KIND_STYLE[i.kind].emoji}</span>
              <div className="grow">
                <strong>{i.title}</strong>
                <small className="muted" style={{ display: 'block' }}>{i.text}</small>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Card>
  );
}
