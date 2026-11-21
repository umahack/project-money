import { useId } from 'react';
import { Link } from 'react-router-dom';
import { actionEffectText, actionLabelText } from '../../clarity/actionCopy';
import type { ActionableInsight } from '../../clarity/contracts';
import { INFORMATIONAL_DISCLAIMER } from './format';
import './clarity.css';

const MEASUREMENT_PARAM = 'rid';
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PLACEHOLDER_ORIGIN = 'https://route.invalid';

/**
 * Returns an in-app path (`/spending?action=correct-expense&expenseId=3`) or
 * null. Anything that could leave the app, such as an absolute URL, a
 * protocol-relative URL, or a backslash path, is rejected. Server data is not
 * trusted to choose where the browser goes.
 */
export function safeInternalRoute(route: string | undefined, measurementId?: string): string | null {
  if (!route || !route.startsWith('/') || route.startsWith('//') || route.includes('\\') || /[\u0000-\u001f\u007f]/.test(route)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(route, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  // The measurement ID is an opaque token only; free text is dropped, never encoded into the URL.
  if (measurementId && OPAQUE_ID.test(measurementId)) {
    url.searchParams.set(MEASUREMENT_PARAM, measurementId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface ActionLinkProps {
  /** Ranked action from the snapshot. Supplies the label, route, expected effect, and disclaimer. */
  insight?: ActionableInsight;
  /** Explicit target and label when there is no insight (for example "Add this month's salary"). */
  to?: string;
  label?: string;
  /** Opaque recommendation instance ID. Only pass it when analytics is enabled. */
  measurementId?: string;
  /** Called after the link is activated, for example to record a measurement event. */
  onNavigate?: () => void;
  /** Show the observation and expected effect under the link (default true for an insight). */
  showDetails?: boolean;
  /** Show the informational-guidance disclaimer (default true for an insight). */
  showDisclaimer?: boolean;
  variant?: 'primary' | 'ghost';
  className?: string;
}

/**
 * Navigates to the existing page and record context that completes an action.
 * It is a real link, so it works with the keyboard and opens normally.
 */
export function ActionLink({
  insight,
  to,
  label,
  measurementId,
  onNavigate,
  showDetails,
  showDisclaimer,
  variant = 'ghost',
  className = '',
}: ActionLinkProps) {
  const detailId = useId();
  const text = label ?? (insight ? actionLabelText(insight) : '');
  const target = safeInternalRoute(to ?? insight?.route, measurementId ?? insight?.recommendationInstanceId);
  const details = (showDetails ?? !!insight) && insight;
  const disclaimer = showDisclaimer ?? !!insight;

  if (!text) return null;
  return (
    <div className={`clarity-action ${className}`.trim()}>
      {target ? (
        <Link
          to={target}
          className={`btn sm ${variant === 'primary' ? 'primary' : 'ghost'} clarity-action-link`}
          aria-describedby={details || disclaimer ? detailId : undefined}
          onClick={onNavigate}
        >
          {text}
          <span aria-hidden="true"> →</span>
        </Link>
      ) : (
        <span className="clarity-action-unavailable">{text}</span>
      )}
      {(details || disclaimer) && (
        <span id={detailId} className="clarity-action-details small muted">
          {details && <span className="clarity-action-effect">{actionEffectText(details)} </span>}
          {disclaimer && <span className="clarity-disclaimer">{INFORMATIONAL_DISCLAIMER}</span>}
        </span>
      )}
    </div>
  );
}
