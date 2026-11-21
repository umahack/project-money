// Typed client for the versioned data-use and Product Analytics settings API
// (`GET/PATCH /api/clarity/settings`). The notice content is fixed server-side
// and is only ever rendered as plain text. Nothing here carries financial values.
import { api, ApiError } from '../api';

export { DATA_NOTICE_REQUIRED_CODE, DATA_NOTICE_REQUIRED_EVENT } from '../api';

export const CLARITY_SETTINGS_PATH = '/clarity/settings';

export interface DataUseNoticeCategory {
  key: string;
  purposes: string[];
  outcomes: string[];
  accessRoles: string[];
  sharing: string;
  retention: string;
}

export interface DataUseNoticeControls {
  correction: { available: boolean; preservesConfirmedValueUntilSuccess: boolean };
  export: { available: boolean };
  deletion: { available: boolean };
  productAnalytics: {
    available: boolean;
    enabledByDefault: boolean;
    canDisable: boolean;
    prohibitedFields: string[];
  };
}

export interface DataUseNoticeContent {
  version: number;
  title: string;
  categories: DataUseNoticeCategory[];
  sharingDefaults: {
    financialData: string;
    publicTripLinks: string;
    publicTripConfirmationRequired: boolean;
  };
  controls: DataUseNoticeControls;
  acknowledgedVersion: number;
  acknowledgedAt: string | null;
  acknowledgementRequired: boolean;
}

export interface ProductAnalyticsSettings {
  available: boolean;
  enabledByDefault: boolean;
  enabled: boolean;
  consentVersion: number | null;
  changedAt: string | null;
}

export interface ClaritySettings {
  schemaVersion: 1;
  timeZone: string;
  dataUseNotice: DataUseNoticeContent;
  productAnalytics: ProductAnalyticsSettings;
}

function malformed(): never {
  throw new ApiError(0, 'The server returned data-use settings in an unsupported format.', {
    code: 'UNSUPPORTED_CLARITY_SETTINGS',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : malformed();
}

function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : malformed();
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : malformed();
}

function nullableString(value: unknown): string | null {
  return value == null ? null : str(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str) : malformed();
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : malformed();
}

function parseCategory(value: unknown): DataUseNoticeCategory {
  const source = record(value);
  return {
    key: str(source.key),
    purposes: strings(source.purposes),
    outcomes: strings(source.outcomes),
    accessRoles: strings(source.accessRoles),
    sharing: str(source.sharing),
    retention: str(source.retention),
  };
}

/** Copies only the known fields, so unknown server fields never reach the UI. */
export function parseClaritySettings(value: unknown): ClaritySettings {
  const source = record(value);
  if (source.schemaVersion !== 1) malformed();
  const notice = record(source.dataUseNotice);
  const sharing = record(notice.sharingDefaults);
  const controls = record(notice.controls);
  const correction = record(controls.correction);
  const analyticsControl = record(controls.productAnalytics);
  const analytics = record(source.productAnalytics);
  if (!Array.isArray(notice.categories)) malformed();

  return {
    schemaVersion: 1,
    timeZone: str(source.timeZone),
    dataUseNotice: {
      version: int(notice.version),
      title: str(notice.title),
      categories: notice.categories.map(parseCategory),
      sharingDefaults: {
        financialData: str(sharing.financialData),
        publicTripLinks: str(sharing.publicTripLinks),
        publicTripConfirmationRequired: bool(sharing.publicTripConfirmationRequired),
      },
      controls: {
        correction: {
          available: bool(correction.available),
          preservesConfirmedValueUntilSuccess: bool(correction.preservesConfirmedValueUntilSuccess),
        },
        export: { available: bool(record(controls.export).available) },
        deletion: { available: bool(record(controls.deletion).available) },
        productAnalytics: {
          available: bool(analyticsControl.available),
          enabledByDefault: bool(analyticsControl.enabledByDefault),
          canDisable: bool(analyticsControl.canDisable),
          prohibitedFields: strings(analyticsControl.prohibitedFields),
        },
      },
      acknowledgedVersion: int(notice.acknowledgedVersion),
      acknowledgedAt: nullableString(notice.acknowledgedAt),
      acknowledgementRequired: bool(notice.acknowledgementRequired),
    },
    productAnalytics: {
      available: bool(analytics.available),
      enabledByDefault: bool(analytics.enabledByDefault),
      enabled: bool(analytics.enabled),
      consentVersion: analytics.consentVersion == null ? null : int(analytics.consentVersion),
      changedAt: nullableString(analytics.changedAt),
    },
  };
}

export async function fetchClaritySettings(): Promise<ClaritySettings> {
  return parseClaritySettings(await api.get<unknown>(CLARITY_SETTINGS_PATH));
}

/** Records that the user reviewed `noticeVersion`. Never changes Product Analytics. */
export async function acknowledgeDataUseNotice(noticeVersion: number): Promise<ClaritySettings> {
  return parseClaritySettings(
    await api.patch<unknown>(CLARITY_SETTINGS_PATH, { acknowledgedNoticeVersion: noticeVersion }),
  );
}

/** Changes only Product Analytics. Never changes the notice acknowledgement or any financial record. */
export async function setProductAnalyticsEnabled(enabled: boolean): Promise<ClaritySettings> {
  return parseClaritySettings(
    await api.patch<unknown>(CLARITY_SETTINGS_PATH, { analyticsEnabled: enabled }),
  );
}
