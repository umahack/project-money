import { useId, useState } from 'react';
import { prohibitedFieldLabel } from '../../clarity/dataUseLabels';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { Card } from '../ui';
import './dataUse.css';

/**
 * Explicit control for nonessential Product Analytics (Requirements 11.13 to
 * 11.15), shown on Settings. It is off by default, independent of the data-use
 * notice acknowledgement, and turning it off never changes records or results.
 * Turning it off is always allowed. Turning it on needs the current notice.
 * Renders nothing while the financial clarity rollout is off.
 */
export function AnalyticsControl() {
  const gate = useDataUseGate();
  const headingId = useId();
  const helpId = useId();
  const [announcement, setAnnouncement] = useState('');

  if (gate.status === 'disabled') return null;

  const analytics = gate.settings?.productAnalytics ?? null;
  const enabled = analytics?.enabled ?? false;
  const available = analytics?.available ?? false;
  const noticeCurrent = gate.status === 'acknowledged';
  const locked = !analytics || !available || (!enabled && !noticeCurrent);
  const prohibited = gate.settings?.dataUseNotice.controls.productAnalytics.prohibitedFields
    .map(prohibitedFieldLabel)
    .join(', ');

  const toggle = async (next: boolean) => {
    if (gate.analyticsPending) return;
    if (await gate.setAnalytics(next)) {
      setAnnouncement(next
        ? 'Product Analytics is on.'
        : 'Product Analytics is off. Your records and results are unchanged.');
    }
  };

  let lockedReason = '';
  if (locked && !enabled) {
    if (!analytics) lockedReason = gate.status === 'error' ? ' Settings could not be loaded.' : ' Available once your settings load.';
    else if (!available) lockedReason = ' Product Analytics is not available right now.';
    else lockedReason = ' Acknowledge the data-use notice to turn it on.';
  }

  return (
    <Card>
      <h2 id={headingId}>📊 Product Analytics</h2>
      <p id={helpId} className="muted small">
        Optional. Counts when guided steps start, when a result is shown, your Yes, Partly, or No answers,
        and whether recommended actions are completed, so the product can be improved.
        {prohibited ? ` It never includes ${prohibited}.` : ''} It is off until you turn it on, and it is
        separate from your notice acknowledgement. Turning it off stops new events right away and never
        changes your records or results.
      </p>
      <label className="clarity-gate-analytics-label" htmlFor={`${headingId}-toggle`}>
        <input
          id={`${headingId}-toggle`}
          type="checkbox"
          checked={enabled}
          disabled={locked}
          aria-busy={gate.analyticsPending}
          aria-describedby={helpId}
          onChange={(event) => { void toggle(event.target.checked); }}
        />
        <span>Send product usage events</span>
      </label>
      {lockedReason && <p className="muted small">{lockedReason.trim()}</p>}
      {gate.analyticsError && (
        <p role="alert" className="clarity-gate-error">
          {gate.analyticsError} The Product Analytics setting was not changed.
        </p>
      )}
      <p role="status" aria-live="polite" className="clarity-gate-status small">{announcement}</p>
    </Card>
  );
}
