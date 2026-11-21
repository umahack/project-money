import type { ReactNode } from 'react';
import type { OutcomeStatus, ValueClassification } from '../../clarity/contracts';
import { CLASSIFICATION_LABEL, STATUS_PRESENTATION } from './format';
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

/** One labelled value: what it is, how it was produced, and the value itself. */
export function ClassifiedValue({ label, classification, value, emphasis = false }: ClassifiedValueProps) {
  return (
    <div className={`clarity-value${emphasis ? ' clarity-value-emphasis' : ''}`}>
      <span className="clarity-value-label">{label}</span>
      <ClassificationBadge classification={classification} />
      <span className="clarity-value-amount mono">{value}</span>
    </div>
  );
}
