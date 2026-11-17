import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { Card } from './ui';

interface StreakRes {
  current: number;
  longest: number;
  days_logged: number;
}

function emojiFor(n: number): string {
  if (n >= 30) return '⭐';
  if (n >= 14) return '🚀';
  if (n >= 7) return '🔥';
  if (n >= 3) return '✨';
  return '🫡';
}

function copyFor(n: number): string {
  if (n === 0) return 'Log one expense today to start a streak.';
  if (n === 1) return 'Day 1. Nice start.';
  if (n < 7) return `Day ${n}. Keep it up.`;
  if (n < 14) return `${n}-day streak — on fire.`;
  if (n < 30) return `${n}-day streak — momentum.`;
  return `${n}-day streak — habit-forming.`;
}

export function StreakCard() {
  const [data, setData] = useState<StreakRes | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<StreakRes>('/finance/streak')
      .then((r) => { if (alive) setData(r); })
      .catch(() => { /* badge is best-effort */ });
    return () => { alive = false; };
  }, []);

  if (!data) return null;
  const { current, longest } = data;

  return (
    <Card>
      <div className="row between" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>
            <motion.span
              key={current}
              initial={{ scale: 1.3 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', damping: 12 }}
              style={{ display: 'inline-block', marginRight: '0.4rem' }}
            >
              {emojiFor(current)}
            </motion.span>
            Logging streak
          </h2>
          <p className="muted small" style={{ marginTop: '0.3rem' }}>{copyFor(current)}</p>
        </div>
        <div className="row" style={{ gap: '0.8rem', alignItems: 'baseline' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="mono" style={{ fontSize: '1.8rem', fontWeight: 800, lineHeight: 1 }}>{current}</div>
            <small className="muted">today</small>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div className="mono" style={{ fontSize: '1.3rem', fontWeight: 700, lineHeight: 1 }}>{longest}</div>
            <small className="muted">longest</small>
          </div>
        </div>
      </div>
    </Card>
  );
}
