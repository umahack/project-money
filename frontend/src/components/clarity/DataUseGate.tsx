import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { prohibitedFieldLabel } from '../../clarity/dataUseLabels';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { DataUseNotice } from './DataUseNotice';
import './dataUse.css';

/** Id of the paused-entries reason. Disabled submit controls can reference it with `aria-describedby`. */
export const DATA_USE_REASON_ID = 'clarity-data-use-reason';

/** Id of the notice the User opens with "Review the data-use notice". The Quick Add shortcut leaves the key alone while it is open. */
export const DATA_USE_NOTICE_REVIEW_ID = 'clarity-notice-review';

function formatAcknowledgedAt(value: string | null, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone });
  } catch {
    return null;
  }
}

/**
 * Compact data-use control shown above signed-in pages. The full notice and the acknowledge action
 * live on the Agreement page (`/agreement`). While the notice is required this shows a short line
 * linking there, plus the paused-entries reason (DATA_USE_REASON_ID). Existing data stays readable,
 * and correction, export, deletion, and the Product Analytics control stay visible.
 * Product Analytics never changes whether financial inputs are enabled.
 *
 * Once the current notice is acknowledged and entries are on, the card collapses to a small
 * "Your data" control. It is a disclosure: it opens the full notice, the correction, export and
 * deletion links, and the Product Analytics control. While settings load or fail to load, and
 * whenever entries are paused, the card stays open with its reason.
 */
export function DataUseGate() {
  const gate = useDataUseGate();
  const detailsId = useId();
  const [announcement, setAnnouncement] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const { settings, status } = gate;
  // The control exists only while the notice is acknowledged and nothing is paused. Entries paused
  // (for example the promise is not yet shown) always show their reason, so the card cannot collapse then.
  const collapsible = status === 'acknowledged' && !gate.reason;
  const collapsed = collapsible && !detailsOpen;

  useEffect(() => {
    if (!collapsible && detailsOpen) setDetailsOpen(false);
  }, [collapsible, detailsOpen]);


  if (status === 'disabled') return null;

  const notice = settings?.dataUseNotice ?? null;
  const analytics = settings?.productAnalytics ?? null;
  const analyticsEnabled = analytics?.enabled ?? false;
  // Turning Product Analytics off is always allowed. Turning it on needs the current notice.
  const analyticsLocked = !analytics || (!analyticsEnabled && status !== 'acknowledged');
  const prohibited = notice?.controls.productAnalytics.prohibitedFields.map(prohibitedFieldLabel).join(', ');
  const acknowledgedOn = notice ? formatAcknowledgedAt(notice.acknowledgedAt, settings?.timeZone ?? 'Asia/Kolkata') : null;


  const toggleAnalytics = async (next: boolean) => {
    if (gate.analyticsPending) return;
    if (await gate.setAnalytics(next)) {
      setAnnouncement(next ? 'Product Analytics is on.' : 'Product Analytics is off. Your records and results are unchanged.');
    }
  };

  return (
    <section
      className={`clarity-gate${collapsible || status === 'required' ? ' clarity-gate-compact' : ''}`}
      aria-labelledby="clarity-gate-title"
      data-gate-status={status}
      data-inputs-enabled={gate.financialInputsEnabled}
      data-collapsed={collapsed}
    >
      <div className="clarity-gate-head">
        <h2
          id="clarity-gate-title"
          tabIndex={-1}
          className={`clarity-gate-title${collapsed ? ' sr-only' : ''}`}
        >
          Your data, your control
        </h2>
        {collapsible && (
          <button
            type="button"
            className="btn ghost sm clarity-gate-toggle"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <span aria-hidden="true" className="clarity-chevron">{detailsOpen ? '▾' : '▸'}</span>
            Your data
          </button>
        )}
      </div>

      <div id={detailsId} className="clarity-gate-body" hidden={collapsed}>
        {status === 'loading' && <p>Checking your data-use settings.</p>}

        {status === 'error' && (
          <div>
            <p role="alert" className="clarity-gate-error">
              Your data-use settings could not be loaded. Your saved data is still readable.
            </p>
            <button type="button" className="btn sm" onClick={gate.retry}>Retry loading settings</button>
          </div>
        )}

        {status === 'required' && (
          <p className="clarity-gate-agreement">
            <Link className="link" to="/agreement">Review and agree to the data-use notice</Link>
            {' '}to add new financial entries.
          </p>
        )}
        {status === 'acknowledged' && notice && (
          <>
            <p>
              You acknowledged the data-use notice (version {notice.acknowledgedVersion})
              {acknowledgedOn ? ` on ${acknowledgedOn}` : ''}. Your data is private to you by default.
            </p>
            <div className="clarity-gate-details">
              <button
                type="button"
                className="btn ghost sm"
                aria-expanded={reviewOpen}
                aria-controls={DATA_USE_NOTICE_REVIEW_ID}
                onClick={() => setReviewOpen((open) => !open)}
              >
                <span aria-hidden="true" className="clarity-chevron">{reviewOpen ? '▾' : '▸'}</span>
                Review the data-use notice
              </button>
              <div id={DATA_USE_NOTICE_REVIEW_ID} hidden={!reviewOpen}>
                {reviewOpen && <DataUseNotice notice={notice} />}
              </div>
            </div>
          </>
        )}

        {gate.reason && (
          <div id={DATA_USE_REASON_ID} className="clarity-gate-paused">
            <p>
              <strong>New entries are paused.</strong> {gate.reason}
            </p>
            <p>
              <strong>Still available:</strong> viewing everything you have saved, correcting records,{' '}
              <Link className="link" to="/settings">exporting your data</Link>, and{' '}
              <Link className="link" to="/settings">deleting your account and data</Link>.
            </p>
          </div>
        )}

        <div className="clarity-gate-analytics">
          <label className="clarity-gate-analytics-label" htmlFor="clarity-analytics-toggle">
            <input
              id="clarity-analytics-toggle"
              type="checkbox"
              checked={analyticsEnabled}
              disabled={analyticsLocked}
              aria-busy={gate.analyticsPending}
              aria-describedby="clarity-analytics-help"
              onChange={(event) => { void toggleAnalytics(event.target.checked); }}
            />
            <span>Product Analytics (optional)</span>
          </label>
          <p id="clarity-analytics-help" className="muted small">
            Off by default and separate from your notice acknowledgement.
            {prohibited ? ` It never includes ${prohibited}.` : ''}{' '}
            Turning it on or off never changes your records or results.
            {analyticsLocked && !analyticsEnabled
              ? (analytics ? ' Acknowledge the data-use notice to turn it on.' : ' Available once your settings load.')
              : ''}
          </p>
          {gate.analyticsError && (
            <p role="alert" className="clarity-gate-error">
              {gate.analyticsError} The Product Analytics setting was not changed.
            </p>
          )}
        </div>
      </div>

      {/* Always rendered so a change is announced. Visually hidden while the card is collapsed. */}
      <p role="status" aria-live="polite" className={`clarity-gate-status small${collapsed ? ' sr-only' : ''}`}>{announcement}</p>
    </section>
  );
}
