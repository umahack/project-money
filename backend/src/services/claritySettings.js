import { FINANCIAL_CLARITY_TIME_ZONE } from '../domain/monthlyPlan.js';
import measurementRepository from '../repositories/measurementRepository.js';

export const CLARITY_SETTINGS_SCHEMA_VERSION = 1;
export const CURRENT_DATA_USE_NOTICE_VERSION = 1;
export const CURRENT_ANALYTICS_CONSENT_VERSION = 1;

const SETTINGS_PATCH_FIELDS = Object.freeze([
  'acknowledgedNoticeVersion',
  'analyticsEnabled',
]);
const SETTINGS_PATCH_FIELD_SET = new Set(SETTINGS_PATCH_FIELDS);

const ACCOUNT_AND_SERVICE_ACCESS = Object.freeze([
  'account_user',
  'authorized_administrators',
  'service_operators_and_processors',
]);

export const DATA_USE_NOTICE = Object.freeze({
  version: CURRENT_DATA_USE_NOTICE_VERSION,
  title: 'How Project Money uses your data',
  categories: Object.freeze([
    Object.freeze({
      key: 'salary',
      purposes: Object.freeze(['calculate and explain monthly spending and saving guidance']),
      outcomes: Object.freeze([
        'disposable_income',
        'needs_budget',
        'wants_budget',
        'savings_target',
        'spendable_budget',
        'daily_spending_guide',
        'projected_savings',
        'goal_feasibility',
      ]),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'private',
      retention: 'until_account_deletion',
    }),
    Object.freeze({
      key: 'bills',
      purposes: Object.freeze(['calculate and explain fixed obligations and available income']),
      outcomes: Object.freeze([
        'disposable_income',
        'needs_budget',
        'wants_budget',
        'savings_target',
        'spendable_budget',
        'daily_spending_guide',
        'projected_savings',
        'goal_feasibility',
      ]),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'private',
      retention: 'until_account_deletion',
    }),
    Object.freeze({
      key: 'expenses',
      purposes: Object.freeze(['calculate and explain category spending and remaining monthly capacity']),
      outcomes: Object.freeze([
        'category_total',
        'remaining_spendable_budget',
        'daily_spending_guide',
        'projected_savings',
      ]),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'private',
      retention: 'until_account_deletion',
    }),
    Object.freeze({
      key: 'goals',
      purposes: Object.freeze(['calculate and explain goal funding requirements and feasibility']),
      outcomes: Object.freeze([
        'goal_funding_gap',
        'required_goal_contribution',
        'goal_feasibility',
      ]),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'private',
      retention: 'until_account_deletion',
    }),
    Object.freeze({
      key: 'trips',
      purposes: Object.freeze(['calculate and explain shared balances and settlements']),
      outcomes: Object.freeze(['member_balance', 'trip_settlement']),
      accessRoles: Object.freeze([
        ...ACCOUNT_AND_SERVICE_ACCESS,
        'accepted_trip_members_for_shared_trip_fields',
        'confirmed_public_link_viewers_for_disclosed_trip_fields',
      ]),
      sharing: 'private_until_separate_public_sharing_confirmation',
      retention: 'until_account_deletion_or_private_trip_removal',
    }),
    Object.freeze({
      key: 'journey_state',
      purposes: Object.freeze(['resume the selected guided journey without duplicate data entry']),
      outcomes: Object.freeze(['first_meaningful_outcome']),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'private',
      retention: 'until_account_deletion',
    }),
    Object.freeze({
      key: 'change_receipts',
      purposes: Object.freeze(['prevent duplicate financial commands and explain confirmed changes']),
      outcomes: Object.freeze(['confirmed_financial_change']),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'private',
      retention: 'until_account_deletion',
    }),
    Object.freeze({
      key: 'sharing_settings',
      purposes: Object.freeze(['apply and revoke user-confirmed public trip sharing']),
      outcomes: Object.freeze(['public_trip_view']),
      accessRoles: ACCOUNT_AND_SERVICE_ACCESS,
      sharing: 'public_trip_sharing_disabled_by_default',
      retention: 'until_account_deletion_or_sharing_revocation',
    }),
    Object.freeze({
      key: 'product_analytics',
      purposes: Object.freeze(['measure whether the product experience is understood and acted on']),
      outcomes: Object.freeze(['aggregate_product_clarity_metrics']),
      accessRoles: Object.freeze(['authorized_product_analytics_operators_and_processors']),
      sharing: 'disabled_by_default_and_not_public',
      retention: 'until_account_deletion_or_the_published_operational_retention_period',
    }),
  ]),
  sharingDefaults: Object.freeze({
    financialData: 'private',
    publicTripLinks: 'disabled',
    publicTripConfirmationRequired: true,
  }),
  controls: Object.freeze({
    correction: Object.freeze({ available: true, preservesConfirmedValueUntilSuccess: true }),
    export: Object.freeze({ available: true, path: '/api/auth/export' }),
    deletion: Object.freeze({ available: true, path: '/api/auth/account' }),
    productAnalytics: Object.freeze({
      available: true,
      enabledByDefault: false,
      canDisable: true,
      prohibitedFields: Object.freeze([
        'financial_amounts',
        'user_entered_names',
        'free_text_notes',
        'trip_member_identities',
        'trip_names',
      ]),
    }),
  }),
});

function settingsError(code, message, httpStatus, details = {}) {
  return new ClaritySettingsError({ code, message, httpStatus, details });
}

export class ClaritySettingsError extends Error {
  constructor({ code, message, httpStatus, details = {} }) {
    super(message);
    this.name = 'ClaritySettingsError';
    this.code = code;
    this.httpStatus = httpStatus;
    Object.assign(this, details);
  }
}

function assertPositiveUserId(userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw settingsError('INVALID_USER_ID', 'User identifier is invalid.', 400);
  }
}

function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw settingsError(
      'INVALID_SETTINGS_PATCH',
      'Settings update must be a JSON object.',
      400
    );
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw settingsError(
      'EMPTY_SETTINGS_PATCH',
      'Provide a notice acknowledgement or Product Analytics setting.',
      400,
      { allowedFields: SETTINGS_PATCH_FIELDS }
    );
  }

  const unknownFields = keys.filter((key) => !SETTINGS_PATCH_FIELD_SET.has(key));
  if (unknownFields.length > 0) {
    throw settingsError(
      'UNKNOWN_SETTINGS_FIELD',
      'Settings update contains a field that is not accepted.',
      400,
      { field: unknownFields.sort()[0], allowedFields: SETTINGS_PATCH_FIELDS }
    );
  }

  if (Object.hasOwn(patch, 'acknowledgedNoticeVersion')) {
    if (!Number.isSafeInteger(patch.acknowledgedNoticeVersion)
      || patch.acknowledgedNoticeVersion !== CURRENT_DATA_USE_NOTICE_VERSION) {
      throw settingsError(
        'INVALID_NOTICE_VERSION',
        'acknowledgedNoticeVersion must equal the current data-use notice version.',
        400,
        {
          field: 'acknowledgedNoticeVersion',
          currentNoticeVersion: CURRENT_DATA_USE_NOTICE_VERSION,
        }
      );
    }
  }

  if (Object.hasOwn(patch, 'analyticsEnabled') && typeof patch.analyticsEnabled !== 'boolean') {
    throw settingsError(
      'INVALID_ANALYTICS_SETTING',
      'analyticsEnabled must be a boolean.',
      400,
      { field: 'analyticsEnabled' }
    );
  }

  return {
    ...(Object.hasOwn(patch, 'acknowledgedNoticeVersion')
      ? { acknowledgedNoticeVersion: patch.acknowledgedNoticeVersion }
      : {}),
    ...(Object.hasOwn(patch, 'analyticsEnabled')
      ? { analyticsEnabled: patch.analyticsEnabled }
      : {}),
  };
}

function isoTimestamp(value) {
  if (value == null) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const timestamp = new Date(normalized);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function dataNoticeRequiredError({ requiredNoticeVersion, acknowledgedNoticeVersion }) {
  return settingsError(
    'DATA_NOTICE_REQUIRED',
    'Review and acknowledge the current data-use notice before submitting this financial command.',
    428,
    {
      requiredNoticeVersion,
      currentNoticeVersion: CURRENT_DATA_USE_NOTICE_VERSION,
      acknowledgedNoticeVersion,
      settingsPath: '/api/clarity/settings',
    }
  );
}

export class ClaritySettingsService {
  #repository;
  #timeZone;

  constructor({
    repository = measurementRepository,
    timeZone = FINANCIAL_CLARITY_TIME_ZONE,
  } = {}) {
    if (!repository
      || typeof repository.getConsentState !== 'function'
      || typeof repository.acknowledgeDataUseNotice !== 'function'
      || typeof repository.setAnalyticsConsent !== 'function') {
      throw new TypeError('A consent repository with read and update methods is required.');
    }
    if (timeZone !== FINANCIAL_CLARITY_TIME_ZONE) {
      throw new RangeError(`timeZone must be ${FINANCIAL_CLARITY_TIME_ZONE}.`);
    }
    this.#repository = repository;
    this.#timeZone = timeZone;
  }

  async #loadState(userId) {
    assertPositiveUserId(userId);
    const state = await this.#repository.getConsentState(userId);
    if (!state) {
      throw settingsError('SETTINGS_NOT_FOUND', 'Settings were not found.', 404);
    }
    return state;
  }

  #response(state) {
    return {
      schemaVersion: CLARITY_SETTINGS_SCHEMA_VERSION,
      schemaVersions: {
        settings: CLARITY_SETTINGS_SCHEMA_VERSION,
        dataUseNotice: CURRENT_DATA_USE_NOTICE_VERSION,
        productAnalyticsConsent: CURRENT_ANALYTICS_CONSENT_VERSION,
      },
      timeZone: this.#timeZone,
      dataUseNotice: {
        ...structuredClone(DATA_USE_NOTICE),
        acknowledgedVersion: state.dataUseNoticeVersion,
        acknowledgedAt: isoTimestamp(state.dataUseAcknowledgedAt),
        acknowledgementRequired:
          state.dataUseNoticeVersion < CURRENT_DATA_USE_NOTICE_VERSION,
      },
      productAnalytics: {
        available: true,
        enabledByDefault: false,
        enabled: state.analyticsEnabled,
        consentVersion: state.analyticsConsentVersion,
        changedAt: isoTimestamp(state.analyticsChangedAt),
      },
    };
  }

  async getSettings({ userId }) {
    return this.#response(await this.#loadState(userId));
  }

  /** Current Product Analytics consent, read at call time for ingestion gates. */
  async getAnalyticsConsent({ userId }) {
    const state = await this.#loadState(userId);
    return {
      enabled: state.analyticsEnabled,
      consentVersion: state.analyticsConsentVersion,
    };
  }

  async assertDataUseNotice({ userId, requiredNoticeVersion }) {
    if (!Number.isSafeInteger(requiredNoticeVersion)
      || requiredNoticeVersion < 0
      || requiredNoticeVersion > CURRENT_DATA_USE_NOTICE_VERSION) {
      throw new RangeError(
        `requiredNoticeVersion must be between 0 and ${CURRENT_DATA_USE_NOTICE_VERSION}.`
      );
    }
    const state = await this.#loadState(userId);
    if (requiredNoticeVersion > state.dataUseNoticeVersion) {
      throw dataNoticeRequiredError({
        requiredNoticeVersion,
        acknowledgedNoticeVersion: state.dataUseNoticeVersion,
      });
    }
    return state;
  }

  async updateSettings({ userId, patch }) {
    const normalizedPatch = validateSettingsPatch(patch);
    let state = await this.#loadState(userId);
    const resultingAcknowledgedVersion = normalizedPatch.acknowledgedNoticeVersion
      ?? state.dataUseNoticeVersion;

    if (normalizedPatch.analyticsEnabled === true
      && resultingAcknowledgedVersion < CURRENT_DATA_USE_NOTICE_VERSION) {
      throw dataNoticeRequiredError({
        requiredNoticeVersion: CURRENT_DATA_USE_NOTICE_VERSION,
        acknowledgedNoticeVersion: state.dataUseNoticeVersion,
      });
    }

    if (normalizedPatch.acknowledgedNoticeVersion !== undefined) {
      state = await this.#repository.acknowledgeDataUseNotice({
        userId,
        noticeVersion: normalizedPatch.acknowledgedNoticeVersion,
      });
    }

    if (normalizedPatch.analyticsEnabled !== undefined) {
      state = await this.#repository.setAnalyticsConsent({
        userId,
        enabled: normalizedPatch.analyticsEnabled,
        consentVersion: normalizedPatch.analyticsEnabled
          ? CURRENT_ANALYTICS_CONSENT_VERSION
          : null,
      });
    }

    return this.#response(state);
  }
}

const claritySettingsService = new ClaritySettingsService();
export default claritySettingsService;
