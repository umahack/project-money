import { useEffect, useState } from 'react';
import { Card } from './ui';

/**
 * Live "today" strip for the Dashboard. Shows a friendly date header, a
 * ticking clock, and a progress bar for how far through the current month
 * we are — which matches how the daily-spend math is computed.
 */
export function TodayStrip() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick every 30 s — enough for the clock and the month-progress bar to feel
    // live without burning cycles when the tab is open all day.
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const dayNum = now.getDate();
  const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthPct = Math.round((dayNum / totalDays) * 100);
  const daysLeft = totalDays - dayNum;

  const dayName = now.toLocaleDateString('en-IN', { weekday: 'long' });
  const dateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

  const monthName = now.toLocaleDateString('en-IN', { month: 'long' });

  return (
    <Card>
      <div className="today-strip">
        <div className="today-cal" aria-hidden="true">
          <div className="today-cal-month">{monthName.slice(0, 3).toUpperCase()}</div>
          <div className="today-cal-day">{dayNum}</div>
        </div>
        <div className="today-body">
          <strong className="today-head">
            Today · {dayName}
          </strong>
          <small className="muted">{dateStr} · {timeStr}</small>
          <div className="today-progress" aria-label={`${monthPct}% of ${monthName} is over`}>
            <div className="today-progress-fill" style={{ width: `${monthPct}%` }} />
          </div>
          <small className="muted">
            Day {dayNum} of {totalDays} · {monthPct}% of {monthName} done · {daysLeft} day{daysLeft === 1 ? '' : 's'} left
          </small>
        </div>
      </div>
    </Card>
  );
}
