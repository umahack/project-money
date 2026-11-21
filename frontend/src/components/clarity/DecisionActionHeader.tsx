import type { ReactNode } from 'react';
import type { ActionableInsight } from '../../clarity/contracts';
import { ActionLink } from './ActionLink';
import './clarity.css';

export interface DecisionActionHeaderProps {
  /** Page title, for example "Spending". Rendered as the page's h1. */
  title: string;
  /** The decision this page answers, in plain words. */
  decision: string;
  /** Highest-ranked relevant action, when one applies. */
  action?: ActionableInsight | null;
  /** Fixed fallback action when no ranked action exists, such as adding this month's salary. */
  fallbackAction?: { label: string; to: string };
  /** Text shown when neither an action nor a fallback applies. Omit to show nothing. */
  noActionText?: string;
  /** Opaque recommendation instance ID; pass only when analytics is enabled. */
  measurementId?: string;
  onActionNavigate?: () => void;
  /** Optional trailing content such as a month picker. */
  right?: ReactNode;
}

/**
 * Top of every main page: the decision the page answers and the one action that
 * matters most. It replaces the page-specific subtitle (Requirements 1.3 to 1.7).
 */
export function DecisionActionHeader({
  title,
  decision,
  action,
  fallbackAction,
  noActionText,
  measurementId,
  onActionNavigate,
  right,
}: DecisionActionHeaderProps) {
  let actionNode: ReactNode = null;
  if (action) {
    actionNode = <ActionLink insight={action} measurementId={measurementId} onNavigate={onActionNavigate} variant="primary" />;
  } else if (fallbackAction) {
    actionNode = <ActionLink label={fallbackAction.label} to={fallbackAction.to} onNavigate={onActionNavigate} variant="primary" showDisclaimer={false} />;
  } else if (noActionText) {
    actionNode = <p className="clarity-no-action small">{noActionText}</p>;
  }

  return (
    <header className="clarity-decision-header">
      <div className="clarity-decision-text">
        <h1>{title}</h1>
        <p className="clarity-decision">
          <span className="clarity-decision-label">Decision</span> {decision}
        </p>
      </div>
      {(actionNode || right) && (
        <div className="clarity-decision-side">
          {actionNode && (
            <div className="clarity-decision-action">
              <span className="clarity-decision-label">Next action</span>
              {actionNode}
            </div>
          )}
          {right}
        </div>
      )}
    </header>
  );
}
