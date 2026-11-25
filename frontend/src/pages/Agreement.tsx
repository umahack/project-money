import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAgreementGate } from '../clarity/AgreementGateProvider';
import { prohibitedFieldLabel, summarizeNotice } from '../clarity/dataUseLabels';
import { useDataUseGate } from '../clarity/DataUseGateProvider';
import { postAuthDestination } from '../clarity/journeys';
import { DataUseNotice } from '../components/clarity/DataUseNotice';
import { useAuth } from '../state';
import './agreement.css';

interface RecordedLocation {
  pathname: string;
  search?: string;
  hash?: string;
}

/** The location the redirect recorded as `state.from`, or null when it is missing or not an in-app path. */
function recordedDestination(state: unknown): string | null {
  const from = (state as { from?: Partial<RecordedLocation> } | null)?.from;
  if (!from || typeof from.pathname !== 'string') return null;
  // `/agreement` itself would loop, and a path that does not start with one slash is not an in-app path.
  if (!from.pathname.startsWith('/') || from.pathname.startsWith('//') || from.pathname === '/agreement') return null;
  const search = typeof from.search === 'string' ? from.search : '';
  const hash = typeof from.hash === 'string' ? from.hash : '';
  return `${from.pathname}${search}${hash}`;
}

/**
 * The dedicated data-use agreement page at `/agreement`. It renders outside `Shell`, so it has no top
 * navigation, bottom navigation, or Core Promise strip. It carries `clarity-on` like every other clarity page, so the
 * contrast tokens and touch-target sizes in clarity.css apply to it. Agreeing acknowledges the current notice and
 * continues to the place the user was heading. "Not now" continues the same way with new entries paused.
 */
export function Agreement() {
  const { user } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const gate = useDataUseGate();
  const { setNotNow } = useAgreementGate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const detailsId = useId();
  const analyticsHelpId = useId();
  const [expanded, setExpanded] = useState(false);
  const [analyticsNote, setAnalyticsNote] = useState('');
  // True from the moment the user agrees. Keeps the "already acknowledged" redirect to Home from racing
  // the navigation to the Intended_Destination when the acknowledgement lands.
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const { status, settings } = gate;
  const destination = recordedDestination(loc.state)
    ?? postAuthDestination({ isAdmin: !!user?.is_admin, search: '', registered: false });

  // Nothing to agree to: the notice is already acknowledged, or the rollout is off.
  if ((status === 'acknowledged' || status === 'disabled') && !agreed) {
    return <Navigate to="/" replace />;
  }

  const notice = status === 'required' ? (settings?.dataUseNotice ?? null) : null;
  const analytics = settings?.productAnalytics ?? null;
  const analyticsEnabled = analytics?.enabled ?? false;
  // Turning Product Analytics off is always allowed. Turning it on needs the notice acknowledged first.
  const analyticsLocked = !analytics || (!analyticsEnabled && status !== 'acknowledged');
  const prohibited = notice?.controls.productAnalytics.prohibitedFields.map(prohibitedFieldLabel).join(', ');
  const summary = notice ? summarizeNotice(notice) : null;
  const summaryLines = summary
    ? [summary.categoriesSentence, summary.sharingSentence, summary.retentionSentence, summary.controlsSentence]
        .filter((line) => line.length > 0)
    : [];

  const agree = async () => {
    if (gate.acknowledging) return;
    setAgreed(true);
    if (await gate.acknowledge()) {
      nav(destination, { replace: true });
    } else {
      setAgreed(false);
    }
  };

  const notNow = () => {
    setNotNow();
    nav(destination, { replace: true });
  };

  const toggleAnalytics = async (next: boolean) => {
    if (gate.analyticsPending) return;
    setAnalyticsNote('');
    if (await gate.setAnalytics(next)) {
      setAnalyticsNote(next
        ? 'Product Analytics is on.'
        : 'Product Analytics is off. Your records and results are unchanged.');
    }
  };

  let statusMessage = analyticsNote;
  if (status === 'loading') statusMessage = 'Checking your data-use settings…';
  else if (gate.acknowledging) statusMessage = 'Saving your acknowledgement…';
  else if (agreed && status === 'acknowledged') statusMessage = 'Acknowledged. Continuing…';

  return (
    <main className="agreement clarity-on" aria-labelledby="agreement-title">
      <div className="agreement-card">
        <h1 id="agreement-title" ref={headingRef} tabIndex={-1} className="agreement-title">
          Review how Project Money uses your data
        </h1>

        {/* Always rendered so a change is announced. */}
        <p role="status" aria-live="polite" className="agreement-status">{statusMessage}</p>

        {status === 'error' && (
          <div role="alert" className="agreement-error">
            <p>Your data-use settings could not be loaded. Your saved data is still readable.</p>
            <button type="button" className="btn sm" onClick={gate.retry}>Retry loading settings</button>
          </div>
        )}

        {notice && (
          <>
            <p className="agreement-lead">
              Before you add new financial entries, here is the short version.
              {notice.acknowledgedVersion > 0 ? ' The notice changed since you last acknowledged it.' : ''}
            </p>
            <ul className="agreement-summary">
              {summaryLines.map((line) => <li key={line}>{line}</li>)}
            </ul>

            <div className="agreement-details">
              <button
                type="button"
                className="btn ghost sm agreement-details-toggle"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded((open) => !open)}
              >
                <span aria-hidden="true" className="clarity-chevron">{expanded ? '▾' : '▸'}</span>
                Read full details
              </button>
              <div id={detailsId} hidden={!expanded}>
                {expanded && (
                  <>
                    {/* Keeps the heading order h1, h2, h3 for the notice's own h3 title. */}
                    <h2 className="agreement-details-title">Full notice</h2>
                    <DataUseNotice notice={notice} />
                  </>
                )}
              </div>
            </div>

            {analytics?.available && (
              <div className="clarity-gate-analytics agreement-analytics">
                <label className="clarity-gate-analytics-label" htmlFor="agreement-analytics-toggle">
                  <input
                    id="agreement-analytics-toggle"
                    type="checkbox"
                    checked={analyticsEnabled}
                    disabled={analyticsLocked}
                    aria-busy={gate.analyticsPending}
                    aria-describedby={analyticsHelpId}
                    onChange={(event) => { void toggleAnalytics(event.target.checked); }}
                  />
                  <span>Product Analytics (optional)</span>
                </label>
                <p id={analyticsHelpId} className="muted small">
                  Off by default and separate from your notice acknowledgement.
                  {prohibited ? ` It never includes ${prohibited}.` : ''}{' '}
                  Turning it on or off never changes your records or results.
                  {analyticsLocked && !analyticsEnabled ? ' Agree to the data-use notice to turn it on.' : ''}
                </p>
                {gate.analyticsError && (
                  <p role="alert" className="agreement-error-text">
                    {gate.analyticsError} The Product Analytics setting was not changed.
                  </p>
                )}
              </div>
            )}

            <p className="muted small agreement-legal">
              Read the full <Link className="link" to="/terms">Terms</Link> and{' '}
              <Link className="link" to="/privacy">Privacy Policy</Link>.
            </p>

            {gate.acknowledgeError && (
              <div role="alert" className="agreement-error">
                <p>{gate.acknowledgeError} Your acknowledgement was not saved, so try again.</p>
                <button type="button" className="btn sm" onClick={() => { void agree(); }}>Try again</button>
              </div>
            )}

            <div className="agreement-actions">
              <button
                type="button"
                className="btn primary agreement-primary"
                aria-disabled={gate.acknowledging}
                onClick={() => { void agree(); }}
              >
                {gate.acknowledging ? 'Saving…' : 'I agree and continue'}
              </button>
              <button type="button" className="btn ghost agreement-secondary" onClick={notNow}>
                Not now, just look around
              </button>
              <p className="muted small agreement-note">
                If you choose not now, you can read everything you have saved, correct records, export your data,
                and delete your account. New financial entries stay paused until you agree.
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
