import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  accessRoleLabel,
  categoryLabel,
  retentionLabel,
  sharingLabel,
  summarizeNotice,
} from '../clarity/dataUseLabels';
import { postAuthDestination } from '../clarity/journeys';
import type { ClaritySettings, DataUseNoticeContent } from '../clarity/settings';
import { DataUseNotice } from '../components/clarity/DataUseNotice';
import { installAgreementNetwork, renderAgreement, type RecordedFrom } from '../test/agreementHarness';
import { buildSettings } from '../test/claritySettingsBuilder';
import { assertProperty } from '../test/propertyReport';
import { createTestUser, fc, renderAuthenticated } from '../test/test-utils';

// ------------------------------- Generators -------------------------------

const CATEGORY_KEYS = [
  'salary', 'bills', 'expenses', 'goals', 'trips', 'journey_state', 'change_receipts', 'sharing_settings',
  'product_analytics', 'category_memory', 'custom_category',
] as const;
const OUTCOME_KEYS = [
  'disposable_income', 'spendable_budget', 'category_total', 'member_balance', 'trip_settlement',
  'today_allowance', 'custom_outcome',
] as const;
const ACCESS_ROLES = [
  'account_user', 'authorized_administrators', 'service_operators_and_processors',
  'accepted_trip_members_for_shared_trip_fields', 'custom_role',
] as const;
const SHARING_KEYS = [
  'private', 'private_until_separate_public_sharing_confirmation', 'disabled_by_default_and_not_public',
  'disabled', 'custom_sharing',
] as const;
const RETENTION_KEYS = [
  'until_account_deletion', 'until_account_deletion_or_private_trip_removal',
  'until_account_deletion_or_sharing_revocation', 'custom_retention',
] as const;
const PROHIBITED_FIELDS = ['financial_amounts', 'user_entered_names', 'free_text_notes', 'trip_names'] as const;

const textArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ,.]{0,30}$/);

const categoryArb = fc.record({
  key: fc.constantFrom(...CATEGORY_KEYS),
  purposes: fc.array(textArb, { minLength: 1, maxLength: 3 }),
  outcomes: fc.uniqueArray(fc.constantFrom(...OUTCOME_KEYS), { minLength: 1, maxLength: 4 }),
  accessRoles: fc.uniqueArray(fc.constantFrom(...ACCESS_ROLES), { minLength: 1, maxLength: 4 }),
  sharing: fc.constantFrom(...SHARING_KEYS),
  retention: fc.constantFrom(...RETENTION_KEYS),
});

const controlsArb = fc.record({
  correction: fc.record({ available: fc.boolean(), preservesConfirmedValueUntilSuccess: fc.boolean() }),
  export: fc.record({ available: fc.boolean() }),
  deletion: fc.record({ available: fc.boolean() }),
  productAnalytics: fc.record({
    available: fc.boolean(),
    enabledByDefault: fc.boolean(),
    canDisable: fc.boolean(),
    prohibitedFields: fc.uniqueArray(fc.constantFrom(...PROHIBITED_FIELDS), { maxLength: 4 }),
  }),
});

/** A notice that still requires acknowledgement, which is the only kind the Agreement page shows. */
const noticeArb: fc.Arbitrary<DataUseNoticeContent> = fc.record({
  version: fc.integer({ min: 1, max: 5 }),
  title: textArb,
  categories: fc.uniqueArray(categoryArb, { maxLength: 4, selector: (category) => category.key }),
  sharingDefaults: fc.record({
    financialData: fc.constantFrom(...SHARING_KEYS),
    publicTripLinks: fc.constantFrom(...SHARING_KEYS),
    publicTripConfirmationRequired: fc.boolean(),
  }),
  controls: controlsArb,
  previouslyAcknowledged: fc.integer({ min: 0, max: 4 }),
}).map(({ previouslyAcknowledged, ...notice }) => {
  const acknowledgedVersion = Math.min(previouslyAcknowledged, notice.version - 1);
  return {
    ...notice,
    acknowledgedVersion,
    acknowledgedAt: acknowledgedVersion > 0 ? '2026-01-10T05:00:00.000Z' : null,
    acknowledgementRequired: true,
  };
});

const settingsArb: fc.Arbitrary<ClaritySettings> = fc.record({
  notice: noticeArb,
  analyticsAvailable: fc.boolean(),
  analyticsEnabled: fc.boolean(),
}).map(({ notice, analyticsAvailable, analyticsEnabled }) => {
  const base = buildSettings();
  return {
    ...base,
    dataUseNotice: notice,
    productAnalytics: { ...base.productAnalytics, available: analyticsAvailable, enabled: analyticsEnabled },
  };
});

const SEGMENTS = ['spending', 'plan', 'goals', 'trips', '7', 'x1', 'settings', 'admin', 'agreement-x'] as const;
const QUERY_KEYS = ['month', 'start', 'q', 'id'] as const;
const QUERY_VALUES = ['2026-01', 'save', 'a', '7'] as const;

/** Non-empty pathname and search, as the redirect records them. Never `/agreement`, which the page rejects. */
const fromArb: fc.Arbitrary<RecordedFrom & { search: string }> = fc.record({
  pathname: fc.array(fc.constantFrom(...SEGMENTS), { minLength: 1, maxLength: 3 }).map((parts) => `/${parts.join('/')}`),
  search: fc
    .array(fc.tuple(fc.constantFrom(...QUERY_KEYS), fc.constantFrom(...QUERY_VALUES)), { minLength: 1, maxLength: 3 })
    .map((pairs) => `?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}`),
});

const READ_FULL_DETAILS = { name: /read full details/i };
const AGREE = { name: 'I agree and continue' };
const NOT_NOW = { name: 'Not now, just look around' };

// ---------------------------------- Tests ----------------------------------

/**
 * Feature: data-use-agreement-page, Property 2: The Agreement_Page always exposes its required elements
 *
 * **Validates: Requirements 1.2**
 */
describe('Property 2: The Agreement_Page always exposes its required elements', () => {
  it('shows the summary, details control, legal links, and both choices for any required notice', async () => {
    await assertProperty(
      fc.asyncProperty(settingsArb, async (settings) => {
        try {
          installAgreementNetwork({ settings });
          const { container } = renderAgreement();

          const expand = await screen.findByRole('button', READ_FULL_DETAILS);
          expect(expand).toHaveAttribute('aria-expanded', 'false');

          // The summary is the one derived from this notice, and it has content.
          const summary = container.querySelector('ul.agreement-summary');
          expect(summary).not.toBeNull();
          const { categoriesSentence, sharingSentence, retentionSentence, controlsSentence } = summarizeNotice(
            settings.dataUseNotice,
          );
          const expected = [categoriesSentence, sharingSentence, retentionSentence, controlsSentence]
            .filter((line) => line.length > 0);
          expect(expected.length).toBeGreaterThan(0);
          expect(within(summary as HTMLElement).getAllByRole('listitem').map((item) => item.textContent))
            .toEqual(expected);

          expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
          expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
          expect(screen.getByRole('button', AGREE)).toBeInTheDocument();
          expect(screen.getByRole('button', NOT_NOW)).toBeInTheDocument();
        } finally {
          cleanup();
        }
      }),
    );
  }, 180_000);
});

/**
 * Feature: data-use-agreement-page, Property 3: "Read full details" always reveals the complete notice
 *
 * **Validates: Requirements 1.3**
 */
describe('Property 3: "Read full details" always reveals the complete notice', () => {
  it('renders the same notice DataUseNotice renders directly for the same value', async () => {
    await assertProperty(
      fc.asyncProperty(settingsArb, async (settings) => {
        const notice = settings.dataUseNotice;
        let shownOnPage = '';
        let pageText = '';
        try {
          installAgreementNetwork({ settings });
          const { container } = renderAgreement();
          const expand = await screen.findByRole('button', READ_FULL_DETAILS);
          // Collapsed until asked for.
          expect(container.querySelector('.clarity-notice')).toBeNull();
          fireEvent.click(expand);
          expect(expand).toHaveAttribute('aria-expanded', 'true');
          const revealed = container.querySelector('.clarity-notice');
          expect(revealed).not.toBeNull();
          shownOnPage = (revealed as HTMLElement).innerHTML;
          pageText = (revealed as HTMLElement).textContent ?? '';
        } finally {
          cleanup();
        }

        let shownDirectly = '';
        try {
          const { container } = renderAuthenticated(<DataUseNotice notice={notice} />);
          shownDirectly = container.querySelector('.clarity-notice')?.innerHTML ?? '';
        } finally {
          cleanup();
        }

        expect(shownOnPage).toBe(shownDirectly);
        expect(shownOnPage.length).toBeGreaterThan(0);

        // The category, sharing, retention, and controls content is all there.
        expect(pageText).toContain(notice.title);
        for (const category of notice.categories) {
          expect(pageText).toContain(categoryLabel(category.key));
          expect(pageText).toContain(sharingLabel(category.sharing));
          expect(pageText).toContain(retentionLabel(category.retention));
          for (const role of category.accessRoles) expect(pageText).toContain(accessRoleLabel(role));
        }
        expect(pageText).toContain('Your controls');
        expect(pageText).toContain('Product Analytics:');
      }),
    );
  }, 180_000);
});

/**
 * Feature: data-use-agreement-page, Property 4: Agreeing navigates to the recorded Intended_Destination
 *
 * **Validates: Requirements 2.1, 2.4**
 */
describe('Property 4: Agreeing navigates to the recorded Intended_Destination', () => {
  it('goes to the exact recorded pathname and search on success and stays put on failure', async () => {
    await assertProperty(
      fc.asyncProperty(fromArb, fc.boolean(), async (from, succeeds) => {
        try {
          const network = installAgreementNetwork({ settings: buildSettings(), patch: succeeds ? 'ok' : 'fail' });
          renderAgreement({ from });
          fireEvent.click(await screen.findByRole('button', AGREE));

          if (succeeds) {
            await screen.findByTestId('landed');
            expect(screen.getByTestId('location')).toHaveTextContent(`${from.pathname}${from.search}`);
            expect(screen.getByTestId('location').textContent).toBe(`${from.pathname}${from.search}`);
            expect(network.patches()).toEqual([{ acknowledgedNoticeVersion: 1 }]);
          } else {
            // The failure is shown first, so staying put is not just navigation that has not happened yet.
            await screen.findByRole('button', { name: 'Try again' });
            expect(screen.getByTestId('location').textContent).toBe('/agreement');
            expect(screen.queryByTestId('landed')).toBeNull();
            expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
          }
        } finally {
          cleanup();
        }
      }),
    );
  }, 240_000);
});

/**
 * Feature: data-use-agreement-page, Property 5: The no-destination fallback matches the existing post-login target
 *
 * **Validates: Requirements 2.2**
 *
 * The notice must be required for there to be something to agree to, so the data-use provider is switched on in
 * every case. `rolloutEnabled` sets the build flag that `postAuthDestination` reads.
 */
describe('Property 5: The no-destination fallback matches the existing post-login target', () => {
  it('agrees to the same target postAuthDestination returns for each (isAdmin, rolloutEnabled)', async () => {
    await assertProperty(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (isAdmin, rolloutEnabled) => {
        try {
          vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', rolloutEnabled ? 'true' : 'false');
          installAgreementNetwork({ settings: buildSettings() });
          renderAgreement({ user: createTestUser({ is_admin: isAdmin }) });
          fireEvent.click(await screen.findByRole('button', AGREE));
          await screen.findByTestId('landed');

          const expected = postAuthDestination({ isAdmin, search: '', registered: false });
          expect(screen.getByTestId('location').textContent).toBe(expected);
          // Written out, so the check does not only compare the page to the function it calls.
          expect(expected).toBe(isAdmin ? '/admin' : '/');
        } finally {
          cleanup();
          vi.unstubAllEnvs();
        }
      }),
    );
  }, 180_000);
});

/**
 * Feature: data-use-agreement-page, Property 6: "Not now" navigates to the recorded Intended_Destination and sets the choice
 *
 * **Validates: Requirements 3.1**
 */
describe('Property 6: "Not now" navigates to the recorded Intended_Destination and sets the choice', () => {
  it('goes to the exact recorded pathname and search and leaves Not_Now_Choice true', async () => {
    await assertProperty(
      fc.asyncProperty(fromArb, async (from) => {
        try {
          const network = installAgreementNetwork({ settings: buildSettings() });
          renderAgreement({ from });
          await screen.findByRole('button', AGREE);
          expect(screen.getByTestId('not-now').textContent).toBe('false');

          fireEvent.click(screen.getByRole('button', NOT_NOW));
          await screen.findByTestId('landed');

          expect(screen.getByTestId('location').textContent).toBe(`${from.pathname}${from.search}`);
          await waitFor(() => expect(screen.getByTestId('not-now').textContent).toBe('true'));
          // Choosing not now acknowledges nothing.
          expect(network.patches()).toEqual([]);
        } finally {
          cleanup();
        }
      }),
    );
  }, 180_000);
});
