export const CLARITY_CONTRACT_HEADER = 'X-Clarity-Contract';
export const CLARITY_CONTRACT_VERSION = '1';

export type FinancialClarityEnvironment = Readonly<Record<string, unknown>> & {
  VITE_FINANCIAL_CLARITY_ENABLED?: unknown;
  VITE_QUICK_ADD_ENABLED?: unknown;
};

export type FinancialClarityUiMode = 'legacy' | 'clarity';
export type FinancialClarityReadPath = 'legacy' | 'clarity';

export interface FinancialClarityRollout {
  enabled: boolean;
  uiMode: FinancialClarityUiMode;
  readPath: FinancialClarityReadPath;
  contractVersion: typeof CLARITY_CONTRACT_VERSION | null;
}

/** Fail-closed: only the strings `1` and `true`, in any letter case and ignoring surrounding whitespace, are on. */
function isFlagOn(rawValue: unknown): boolean {
  return typeof rawValue === 'string' && ['1', 'true'].includes(rawValue.trim().toLowerCase());
}

export function readClientFeatureFlags(
  environment: FinancialClarityEnvironment = import.meta.env,
): Readonly<{ financialClarityEnabled: boolean }> {
  const financialClarityEnabled = isFlagOn(environment.VITE_FINANCIAL_CLARITY_ENABLED);

  return Object.freeze({ financialClarityEnabled });
}

/**
 * The Quick_Add_Flag (`VITE_QUICK_ADD_ENABLED`) read on its own, with the same
 * fail-closed reading as the Rollout_Flag. Off when absent, malformed, or any
 * value other than `1` or `true`. It has no effect by itself: use
 * `selectQuickAddEnabled` to decide whether any Quick Add surface exists.
 */
export function readQuickAddFlag(
  environment: FinancialClarityEnvironment = import.meta.env,
): boolean {
  return isFlagOn(environment.VITE_QUICK_ADD_ENABLED);
}

/**
 * Quick_Add_Enabled: true only while both the Rollout_Flag and the
 * Quick_Add_Flag are on. Every Quick Add surface, request, and the
 * Allowance_Exclusion control must stay behind this value. The flags are read
 * from the build environment, so a change applies at the next application load.
 */
export function selectQuickAddEnabled(
  environment: FinancialClarityEnvironment = import.meta.env,
): boolean {
  return readClientFeatureFlags(environment).financialClarityEnabled && readQuickAddFlag(environment);
}

/**
 * Rollback changes only the selected UI/read contract. It does not clear
 * browser state or issue any mutation that could remove feature data.
 */
export function selectFinancialClarityRollout(
  environment: FinancialClarityEnvironment = import.meta.env,
): Readonly<FinancialClarityRollout> {
  const enabled = readClientFeatureFlags(environment).financialClarityEnabled;
  return Object.freeze({
    enabled,
    uiMode: enabled ? 'clarity' : 'legacy',
    readPath: enabled ? 'clarity' : 'legacy',
    contractVersion: enabled ? CLARITY_CONTRACT_VERSION : null,
  });
}

function supportsClarityContract(path: string, auth: boolean): boolean {
  return auth && /^\/(?:finance|trips)(?:\/|$)/.test(path);
}

export function clarityContractHeaders(
  path: string,
  auth: boolean,
  environment: FinancialClarityEnvironment = import.meta.env,
): Readonly<Record<string, string>> {
  const rollout = selectFinancialClarityRollout(environment);
  if (!rollout.enabled || !supportsClarityContract(path, auth)) return Object.freeze({});
  return Object.freeze({ [CLARITY_CONTRACT_HEADER]: CLARITY_CONTRACT_VERSION });
}
