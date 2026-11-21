import type { ReactNode } from 'react';
import type { ActionableInsight } from '../../clarity/contracts';
import { selectFinancialClarityRollout } from '../../clarity/rollout';
import { PageTitle } from '../ui';
import { DecisionActionHeader } from './DecisionActionHeader';

export interface ClarityPageHeaderProps {
  /** Header shown while the rollout flag is off. Rendered exactly as before. */
  legacy: { title: string; sub?: string; right?: ReactNode };
  /** Page heading when the rollout flag is on. */
  title: string;
  decision: string;
  action?: ActionableInsight | null;
  fallbackAction?: { label: string; to: string } | null;
  noActionText?: string;
  /** Trailing content for the clarity header, such as a period pill. */
  right?: ReactNode;
}

/**
 * Page header for the five main pages. With the rollout flag off it renders the
 * existing `PageTitle`. With the flag on it names the decision and the highest
 * relevant action before any form or generic description.
 */
export function ClarityPageHeader({ legacy, title, decision, action, fallbackAction, noActionText, right }: ClarityPageHeaderProps) {
  if (!selectFinancialClarityRollout().enabled) {
    return <PageTitle title={legacy.title} sub={legacy.sub} right={legacy.right} />;
  }
  return (
    <DecisionActionHeader
      title={title}
      decision={decision}
      action={action}
      fallbackAction={fallbackAction ?? undefined}
      noActionText={noActionText}
      right={right}
    />
  );
}
