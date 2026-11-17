import { useEffect, useState } from 'react';

/**
 * Mac menu-bar style clock for the signed-in topbar. Ticks once a minute
 * and resyncs on focus so it never drifts after a backgrounded tab.
 * Format: "Wed · 18 Nov · 12:56 am". On ≤420px, drops the weekday to fit.
 */
export function TopbarClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const weekday = now.toLocaleDateString('en-IN', { weekday: 'short' });
  const dayMon = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <time className="top-clock" aria-label={`${weekday} ${dayMon} ${time}`} dateTime={now.toISOString()}>
      <span className="tc-day">{weekday}</span>
      <span className="tc-sep">·</span>
      <span className="tc-date">{dayMon}</span>
      <span className="tc-sep">·</span>
      <span className="tc-time">{time}</span>
    </time>
  );
}
