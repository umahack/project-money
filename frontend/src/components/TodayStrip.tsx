import { useEffect, useState } from 'react';

/**
 * Live "today" strip for the Dashboard. Shows a friendly date header, a
 * ticking clock, and a progress bar for how far through the current month
 * we are — which matches how the daily-spend math is computed.
 */
export function TodayStrip() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick every 30 s so the clock and month-progress bar stay live.
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    // Mobile browsers pause timers in background tabs; snap to real time
    // the moment the tab is foregrounded again.
    const onVis = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const dayNum = now.getDate();
  const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthPct = Math.round((dayNum / totalDays) * 100);
  const daysLeft = totalDays - dayNum;

  const dayName = now.toLocaleDateString('en-IN', { weekday: 'long' });
  const dateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

  const monthName = now.toLocaleDateString('en-IN', { month: 'long' });

  // Topbar now carries date + time; this strip focuses on the month-
  // progress visual, which is what the daily-spend math is tied to.
  return (
    <div className="month-strip">
      <div className="month-strip-head">
        <strong>{monthName} progress</strong>
        <small className="muted">
          Day {dayNum} of {totalDays} · {monthPct}% done · {daysLeft} day{daysLeft === 1 ? '' : 's'} left
        </small>
      </div>
      <div className="today-progress" aria-label={`${monthPct}% of ${monthName} is over`}>
        <div className="today-progress-fill" style={{ width: `${monthPct}%` }} />
      </div>
      <span className="sr-only">{dateStr} · {timeStr}</span>
    </div>
  );
}
