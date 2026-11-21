import { describe, expect, it } from 'vitest';
import {
  CLARITY_CONTRACT_HEADER,
  clarityContractHeaders,
  readClientFeatureFlags,
  selectFinancialClarityRollout,
} from './rollout';

describe('financial clarity rollout selection', () => {
  it('keeps the legacy UI and read path when the flag is absent or unsupported', () => {
    expect(readClientFeatureFlags({})).toEqual({ financialClarityEnabled: false });
    expect(readClientFeatureFlags({ VITE_FINANCIAL_CLARITY_ENABLED: 'yes' })).toEqual({
      financialClarityEnabled: false,
    });
    expect(selectFinancialClarityRollout({})).toEqual({
      enabled: false,
      uiMode: 'legacy',
      readPath: 'legacy',
      contractVersion: null,
    });
    expect(clarityContractHeaders('/finance/plan', true, {})).toEqual({});
  });

  it('selects the clarity UI/read contract only for an explicit true value', () => {
    for (const value of ['1', 'true', ' TRUE ']) {
      expect(selectFinancialClarityRollout({ VITE_FINANCIAL_CLARITY_ENABLED: value })).toEqual({
        enabled: true,
        uiMode: 'clarity',
        readPath: 'clarity',
        contractVersion: '1',
      });
    }
    expect(
      clarityContractHeaders('/finance/plan', true, {
        VITE_FINANCIAL_CLARITY_ENABLED: 'true',
      }),
    ).toEqual({ [CLARITY_CONTRACT_HEADER]: '1' });
  });

  it('limits negotiation to authenticated financial paths', () => {
    const enabled = { VITE_FINANCIAL_CLARITY_ENABLED: 'true' };

    expect(clarityContractHeaders('/trips/17', true, enabled)).toEqual({
      [CLARITY_CONTRACT_HEADER]: '1',
    });
    expect(clarityContractHeaders('/public/trips/token', true, enabled)).toEqual({});
    expect(clarityContractHeaders('/finance/plan', false, enabled)).toEqual({});
    expect(clarityContractHeaders('/auth/login', true, enabled)).toEqual({});
  });

  it('rollback changes selection without clearing feature data', () => {
    localStorage.setItem('feature-data-marker', 'retained');
    sessionStorage.setItem('feature-session-marker', 'retained');

    expect(selectFinancialClarityRollout({
      VITE_FINANCIAL_CLARITY_ENABLED: 'true',
    }).readPath).toBe('clarity');
    expect(selectFinancialClarityRollout({
      VITE_FINANCIAL_CLARITY_ENABLED: 'false',
    }).readPath).toBe('legacy');

    expect(localStorage.getItem('feature-data-marker')).toBe('retained');
    expect(sessionStorage.getItem('feature-session-marker')).toBe('retained');
  });
});
