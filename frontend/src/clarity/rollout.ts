export const CLARITY_CONTRACT_HEADER = 'X-Clarity-Contract';
export const CLARITY_CONTRACT_VERSION = '1';

export type FinancialClarityEnvironment = Readonly<Record<string, unknown>> & {
  VITE_FINANCIAL_CLARITY_ENABLED?: unknown;
};

export type FinancialClarityUiMode = 'legacy' | 'clarity';
export type FinancialClarityReadPath = 'legacy' | 'clarity';

export interface FinancialClarityRollout {
  enabled: boolean;
  uiMode: FinancialClarityUiMode;
  readPath: FinancialClarityReadPath;
  contractVersion: typeof CLARITY_CONTRACT_VERSION | null;
}

export function readClientFeatureFlags(
  environment: FinancialClarityEnvironment = import.meta.env,
): Readonly<{ financialClarityEnabled: boolean }> {
  const rawValue = environment.VITE_FINANCIAL_CLARITY_ENABLED;
  const financialClarityEnabled = typeof rawValue === 'string'
    && ['1', 'true'].includes(rawValue.trim().toLowerCase());

  return Object.freeze({ financialClarityEnabled });
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
