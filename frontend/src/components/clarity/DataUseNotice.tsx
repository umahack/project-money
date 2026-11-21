import { Link } from 'react-router-dom';
import {
  accessRoleLabel,
  categoryLabel,
  outcomeLabel,
  prohibitedFieldLabel,
  retentionLabel,
  sharingLabel,
} from '../../clarity/dataUseLabels';
import type { DataUseNoticeContent } from '../../clarity/settings';
import './dataUse.css';

/** Lists each outcome once with its definition, then by name only (Requirement 12.10). */
function outcomeItems(categories: DataUseNoticeContent['categories']): string[][] {
  const defined = new Set<string>();
  return categories.map((category) => category.outcomes.map((key) => {
    const { label, definition } = outcomeLabel(key);
    if (defined.has(key) || !definition) return label;
    defined.add(key);
    return `${label}: ${definition}`;
  }));
}

export interface DataUseNoticeProps {
  /** Fixed notice content from the server. Rendered only as plain text. */
  notice: DataUseNoticeContent;
}

/**
 * The versioned Data Use Notice (Requirements 11.1 to 11.3): each data category,
 * the outcomes it powers, who can access it, sharing defaults, retention or
 * deletion events, and the correction, export, deletion, and Product Analytics
 * controls.
 */
export function DataUseNotice({ notice }: DataUseNoticeProps) {
  const outcomes = outcomeItems(notice.categories);
  const { controls, sharingDefaults } = notice;

  return (
    <div className="clarity-notice">
      <h3 className="clarity-notice-title">
        {notice.title} <span className="muted small">(version {notice.version})</span>
      </h3>

      <h4 className="clarity-notice-heading">What we keep, and what it is used for</h4>
      <ul className="clarity-notice-categories">
        {notice.categories.map((category, index) => (
          <li key={category.key} className="clarity-notice-category">
            <h5 className="clarity-notice-category-title">{categoryLabel(category.key)}</h5>
            <dl className="clarity-notice-facts">
              <div>
                <dt>Used to</dt>
                <dd>{category.purposes.join('; ')}</dd>
              </div>
              <div>
                <dt>Results it powers</dt>
                <dd>
                  <ul className="clarity-notice-inline">
                    {(outcomes[index] ?? []).map((text) => <li key={text}>{text}</li>)}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>Who can access it</dt>
                <dd>
                  <ul className="clarity-notice-inline">
                    {category.accessRoles.map((role) => <li key={role}>{accessRoleLabel(role)}</li>)}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>Sharing</dt>
                <dd>{sharingLabel(category.sharing)}</dd>
              </div>
              <div>
                <dt>How long</dt>
                <dd>{retentionLabel(category.retention)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <h4 className="clarity-notice-heading">Sharing defaults</h4>
      <ul className="clarity-notice-list">
        <li>Your financial data: {sharingLabel(sharingDefaults.financialData).toLowerCase()}.</li>
        <li>Public trip links: {sharingLabel(sharingDefaults.publicTripLinks).toLowerCase()}.</li>
        {sharingDefaults.publicTripConfirmationRequired && (
          <li>A separate confirmation, after you review the disclosed fields, is required before any public trip link exists.</li>
        )}
      </ul>

      <h4 className="clarity-notice-heading">Your controls</h4>
      <ul className="clarity-notice-list">
        <li>
          <strong>Correct:</strong>{' '}
          {controls.correction.available
            ? `Correct any record from its page.${controls.correction.preservesConfirmedValueUntilSuccess ? ' Your earlier confirmed value stays until the correction succeeds.' : ''}`
            : 'Correction is not available right now.'}
        </li>
        <li>
          <strong>Export:</strong>{' '}
          {controls.export.available ? <Link className="link" to="/settings">Export your data</Link> : 'Export is not available right now.'}
        </li>
        <li>
          <strong>Delete:</strong>{' '}
          {controls.deletion.available ? <Link className="link" to="/settings">Delete your account and data</Link> : 'Deletion is not available right now.'}
        </li>
        <li>
          <strong>Product Analytics:</strong>{' '}
          {controls.productAnalytics.available
            ? `Optional and separate from everything above. ${controls.productAnalytics.enabledByDefault ? 'It is on by default.' : 'It is off by default.'}${controls.productAnalytics.canDisable ? ' You can turn it off at any time.' : ''} It never includes ${controls.productAnalytics.prohibitedFields.map(prohibitedFieldLabel).join(', ')}.`
            : 'Product Analytics is not available right now.'}
        </li>
      </ul>
    </div>
  );
}
