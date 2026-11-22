import { useContext, type ReactNode } from 'react';
import type { OutcomeStatus, ValueClassification } from '../../clarity/contracts';
import { CLASSIFICATION_LABEL, STATUS_PRESENTATION } from './format';
import { OutcomeLabelContext } from './labelContext';
import './clarity.css';

/** Entered fact / calculated result / recommendation label (Requirement 9.1). */
export function ClassificationBadge({ classification }: { classification: ValueClassification }) {
  return (
    <span className={`clarity-badge clarity-class-${classification}`} data-classification={classification}>
      {CLASSIFICATION_LABEL[classification]}
    </span>
  );
}

/** Status shown as text with a decorative glyph, so meaning never depends on color (Requirement 12.2). */
export function StatusBadge({ status, text }: { status: OutcomeStatus; text?: string }) {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <span className={`clarity-badge clarity-status clarity-tone-${presentation.tone}`} data-status={status}>
      <span aria-hidden="true" className="clarity-glyph">{presentation.glyph}</span>
      {text ?? presentation.label}
    </span>
  );
}

export interface ClassifiedValueProps {
  label: string;
  classification: ValueClassification;
  value: ReactNode;
  /** Larger type for the headline value of a card. */
  emphasis?: boolean;
}

/**
 * One labelled value: what it is, how it was produced, and the value itself.
 *
 * Inside an `OutcomeCard` whose header already states the same classification once, the value does not
 * repeat it as a visible badge. The label stays in the text, hidden visually, so each value is still
 * identified as an entered fact, calculated result, or recommendation to a screen reader. A value whose
 * classification differs from the card's (for example an entered target date in a calculated card)
 * keeps its own visible badge.
 */
export function ClassifiedValue({ label, classification, value, emphasis = false }: ClassifiedValueProps) {
  const stated = useContext(OutcomeLabelContext) === classification;
  return (
    <div className={`clarity-value${emphasis ? ' clarity-value-emphasis' : ''}`}>
      <span className="clarity-value-label">{label}</span>
      {stated
        ? <span className="sr-only" data-classification={classification}>{CLASSIFICATION_LABEL[classification]}</span>
        : <ClassificationBadge classification={classification} />}
      <span className="clarity-value-amount mono">{value}</span>
    </div>
  );
}
