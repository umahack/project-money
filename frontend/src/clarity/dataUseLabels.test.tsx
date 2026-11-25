import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DataUseNotice } from '../components/clarity/DataUseNotice';
import { buildSettings } from '../test/claritySettingsBuilder';
import { axe } from '../test/test-utils';
import { categoryLabel, outcomeLabel, summarizeNotice } from './dataUseLabels';
import type { DataUseNoticeContent } from './settings';

const ACCESS = ['account_user', 'authorized_administrators', 'service_operators_and_processors'];

/** Notice version 2 as the server sends it while the Quick Add server flag is on. */
function versionTwoNotice(): DataUseNoticeContent {
  const notice = structuredClone(buildSettings({ acknowledgedVersion: 1 }).dataUseNotice);
  notice.version = 2;
  const expenses = notice.categories.find((category) => category.key === 'expenses');
  expenses?.purposes.push('calculate and explain today\'s spending allowance, including whether an expense is counted against it');
  expenses?.outcomes.push('today_allowance');
  notice.categories.push({
    key: 'category_memory',
    purposes: ['suggest a category for notes you have typed before'],
    outcomes: ['category_suggestion'],
    accessRoles: ACCESS,
    sharing: 'private',
    retention: 'until_account_deletion',
  });
  return notice;
}

describe('summarizeNotice', () => {
  it('summarizes the notice using only its own categories, defaults, retention, and controls', () => {
    const summary = summarizeNotice(buildSettings().dataUseNotice);
    expect(summary.categoriesSentence).toBe('What we keep: Salary, Expenses, Trips, Product Analytics (optional).');
    expect(summary.sharingSentence).toBe(
      'Your financial data: private to you. Public trip links: off until you confirm a public link. '
      + 'A separate confirmation is required before any public trip link exists.',
    );
    expect(summary.retentionSentence).toContain('Kept until you delete your account');
    expect(summary.controlsSentence).toBe(
      'Your controls: correct records, export your data, delete your account and data. '
      + 'Product Analytics is optional and off by default. You can turn it off at any time.',
    );
  });

  it('reports unavailable controls and an on-by-default analytics setting as the notice states them', () => {
    const notice = structuredClone(buildSettings().dataUseNotice);
    notice.controls.export.available = false;
    notice.controls.productAnalytics.enabledByDefault = true;
    notice.controls.productAnalytics.canDisable = false;
    const { controlsSentence } = summarizeNotice(notice);
    expect(controlsSentence).toContain('Export is not available right now.');
    expect(controlsSentence).toContain('Product Analytics is optional and on by default.');
    expect(controlsSentence).not.toContain('turn it off');
  });
});

describe('notice version 2 labels', () => {
  it('names the new data category and results in plain language, not as humanized keys', () => {
    expect(categoryLabel('category_memory')).toBe('Remembered category choices');
    expect(outcomeLabel('category_suggestion')).toEqual({
      label: 'Category suggestion',
      definition: expect.stringMatching(/category Quick Add proposes for a note you have typed before/),
    });
    expect(outcomeLabel('today_allowance')).toEqual({
      label: 'Today\'s allowance',
      definition: expect.stringMatching(/not counted in the daily allowance/),
    });
  });

  it('shows the category memory entry, its purpose, and the daily-allowance exclusion text in the notice', async () => {
    const { container } = render(<MemoryRouter><DataUseNotice notice={versionTwoNotice()} /></MemoryRouter>);

    const memory = screen.getByRole('heading', { name: 'Remembered category choices' }).closest('li') as HTMLElement;
    expect(within(memory).getByText('suggest a category for notes you have typed before')).toBeInTheDocument();
    expect(memory).toHaveTextContent('Category suggestion: the category Quick Add proposes for a note you have typed before');
    expect(memory).toHaveTextContent('Private to you');
    expect(memory).toHaveTextContent('Kept until you delete your account');

    const expenses = screen.getByRole('heading', { name: 'Expenses' }).closest('li') as HTMLElement;
    expect(expenses).toHaveTextContent('including whether an expense is counted against it');
    expect(expenses).toHaveTextContent('Today\'s allowance: what you can spend today, leaving out any expense you mark as not counted in the daily allowance');
    expect(container).not.toHaveTextContent('Category memory');
    expect(container).not.toHaveTextContent('Today allowance');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the version 1 notice free of the new labels', () => {
    const { container } = render(<MemoryRouter><DataUseNotice notice={buildSettings().dataUseNotice} /></MemoryRouter>);
    expect(container).not.toHaveTextContent('Remembered category choices');
    expect(container).not.toHaveTextContent('Category suggestion');
  });
});
