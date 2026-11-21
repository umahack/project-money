import { useState } from 'react';
import {
  isRequested,
  outcomeTerms,
  purposeFor,
  skipEffect,
  type PurposeDefinition,
  type PurposeInputKind,
  type PurposeOutcomeKey,
} from '../../clarity/purposeRegistry';
import './purpose.css';

export interface PurposeExplanationProps {
  /** One of the fixed input kinds. Purpose copy comes only from the registry. */
  input: PurposeInputKind;
  /** Base for element ids. Defaults to `purpose-<input>`. */
  idPrefix?: string;
  /** Called once when the user skips an optional input. Skipping saves nothing. */
  onSkip?: () => void;
  /** Controls the skipped state. When omitted, the component tracks it itself. */
  skipped?: boolean;
  /**
   * Presents an input that is normally required as optional in this place, for
   * example the pay form in the goal journey, where pay only adds feasibility.
   * `skipOutcome` is the one outcome that stays as it is when the user skips.
   */
  asOptional?: { skipOutcome?: PurposeOutcomeKey };
}

/** Id of the explanation. Put it in the input's `aria-describedby`. */
export function purposeExplanationId(input: PurposeInputKind, idPrefix?: string): string {
  return idPrefix ?? `purpose-${input}`;
}

/**
 * Says why an input is requested, whether it is required or optional, and which
 * outcomes it changes, with each term defined where it first appears
 * (Requirements 2.1 to 2.6, 2.9, 2.10, 2.12, and 12.10). Place it before the input
 * so the required or optional state is read before submission is enabled.
 * An optional input with no named outcome renders nothing.
 */
export function PurposeExplanation({ input, idPrefix, onSkip, skipped, asOptional }: PurposeExplanationProps) {
  const [skippedLocally, setSkippedLocally] = useState(false);
  const base = purposeFor(input);
  const definition: PurposeDefinition | null = base && asOptional
    ? {
      ...base,
      requirement: 'optional',
      skipOutcome: asOptional.skipOutcome && base.outcomes.includes(asOptional.skipOutcome) ? asOptional.skipOutcome : base.skipOutcome,
    }
    : base;
  if (!definition || !isRequested(definition)) return null;

  const id = purposeExplanationId(input, idPrefix);
  const titleId = `${id}-title`;
  const skipTextId = `${id}-skip`;
  const optional = definition.requirement === 'optional';
  const effect = skipEffect(definition);
  const isSkipped = skipped ?? skippedLocally;

  function handleSkip() {
    if (isSkipped) return;
    setSkippedLocally(true);
    onSkip?.();
  }

  return (
    <section
      id={id}
      className="clarity-purpose"
      aria-labelledby={titleId}
      data-input={input}
      data-requirement={definition.requirement}
    >
      <p id={titleId} className="clarity-purpose-title">
        <span>Why we ask for {definition.inputLabel.toLowerCase()}</span>
        <span className={`clarity-badge clarity-tone-${optional ? 'info' : 'warn'} clarity-purpose-requirement`}>
          {optional ? 'Optional' : 'Required'}
        </span>
      </p>
      <p className="clarity-purpose-text">{definition.purpose}</p>
      <p className="clarity-purpose-lead">This changes:</p>
      <ul className="clarity-purpose-terms">
        {outcomeTerms(definition).map((term) => (
          <li key={term.key}>
            <dfn className="clarity-purpose-term">{term.label}</dfn>
            {term.definition ? `: ${term.definition}.` : null}
          </li>
        ))}
      </ul>
      {optional && effect ? (
        <div className="clarity-purpose-skip">
          <p id={skipTextId} className="clarity-purpose-skip-text">If you skip: {effect.text}</p>
          <button type="button" className="btn ghost" aria-describedby={skipTextId} onClick={handleSkip}>
            Skip for now
          </button>
          <p role="status" className="clarity-purpose-skipped">
            {isSkipped ? `Skipped. ${effect.text}` : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
}
