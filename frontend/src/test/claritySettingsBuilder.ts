import type { ClaritySettings } from '../clarity/settings';

// No test-runner imports here: Playwright specs use this builder too.
const ACCESS = ['account_user', 'authorized_administrators', 'service_operators_and_processors'];

export function buildSettings({
  acknowledgedVersion = 0,
  analyticsEnabled = false,
}: { acknowledgedVersion?: number; analyticsEnabled?: boolean } = {}): ClaritySettings {
  const acknowledged = acknowledgedVersion >= 1;
  return {
    schemaVersion: 1,
    timeZone: 'Asia/Kolkata',
    dataUseNotice: {
      version: 1,
      title: 'How Project Money uses your data',
      categories: [
        {
          key: 'salary',
          purposes: ['calculate and explain monthly spending and saving guidance'],
          outcomes: ['disposable_income', 'spendable_budget'],
          accessRoles: ACCESS,
          sharing: 'private',
          retention: 'until_account_deletion',
        },
        {
          key: 'expenses',
          purposes: ['calculate and explain category spending'],
          outcomes: ['disposable_income', 'category_total'],
          accessRoles: ACCESS,
          sharing: 'private',
          retention: 'until_account_deletion',
        },
        {
          key: 'trips',
          purposes: ['calculate and explain shared balances and settlements'],
          outcomes: ['member_balance', 'trip_settlement'],
          accessRoles: [...ACCESS, 'accepted_trip_members_for_shared_trip_fields'],
          sharing: 'private_until_separate_public_sharing_confirmation',
          retention: 'until_account_deletion_or_private_trip_removal',
        },
        {
          key: 'product_analytics',
          purposes: ['measure whether the product experience is understood and acted on'],
          outcomes: ['aggregate_product_clarity_metrics'],
          accessRoles: ['authorized_product_analytics_operators_and_processors'],
          sharing: 'disabled_by_default_and_not_public',
          retention: 'until_account_deletion_or_the_published_operational_retention_period',
        },
      ],
      sharingDefaults: {
        financialData: 'private',
        publicTripLinks: 'disabled',
        publicTripConfirmationRequired: true,
      },
      controls: {
        correction: { available: true, preservesConfirmedValueUntilSuccess: true },
        export: { available: true },
        deletion: { available: true },
        productAnalytics: {
          available: true,
          enabledByDefault: false,
          canDisable: true,
          prohibitedFields: ['financial_amounts', 'free_text_notes'],
        },
      },
      acknowledgedVersion,
      acknowledgedAt: acknowledged ? '2026-01-10T05:00:00.000Z' : null,
      acknowledgementRequired: !acknowledged,
    },
    productAnalytics: {
      available: true,
      enabledByDefault: false,
      enabled: analyticsEnabled,
      consentVersion: analyticsEnabled ? 1 : null,
      changedAt: null,
    },
  };
}
