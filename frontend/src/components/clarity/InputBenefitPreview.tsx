import { previewFor, purposeFor, type ConfirmedState, type PurposeInputKind } from '../../clarity/purposeRegistry';
import './purpose.css';

export interface InputBenefitPreviewProps {
  input: PurposeInputKind;
  /**
   * What the user has already confirmed. When the input has an existing value,
   * the preview shows those values. Otherwise it shows a fixed example that is
   * visibly labelled "Example, not your data."
   */
  confirmed?: ConfirmedState | null;
  /** Base for element ids. Defaults to `benefit-<input>`. */
  idPrefix?: string;
}

/**
 * Previews the outcomes a requested input changes before the user submits it
 * (Requirements 2.7 and 2.8). Every value is rendered as text.
 */
export function InputBenefitPreview({ input, confirmed, idPrefix }: InputBenefitPreviewProps) {
  const preview = previewFor(input, confirmed);
  if (!preview) return null;
  const id = idPrefix ?? `benefit-${input}`;
  const titleId = `${id}-title`;
  const inputLabel = purposeFor(input)?.inputLabel.toLowerCase() ?? input;
  return (
    <section
      id={id}
      className="clarity-benefit"
      aria-labelledby={titleId}
      data-input={input}
      data-source={preview.source}
    >
      <p id={titleId} className="clarity-benefit-title">
        <span>What {inputLabel} unlocks</span>
        <span className={`clarity-badge clarity-tone-${preview.source === 'example' ? 'warn' : 'ok'} clarity-benefit-source`}>
          {preview.sourceLabel}
        </span>
      </p>
      {preview.basis ? <p className="clarity-benefit-basis">{preview.basis}</p> : null}
      <dl className="clarity-benefit-lines">
        {preview.lines.map((line) => (
          <div key={line.outcome} className="clarity-benefit-line" data-available={line.available}>
            <dt>{line.label}</dt>
            <dd className="mono">{line.valueText}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
