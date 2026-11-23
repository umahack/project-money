import { describe, expect, it, vi } from 'vitest';
import {
  CLARITY_CONTRACT_HEADER,
  clarityContractHeaders,
  readClientFeatureFlags,
  readQuickAddFlag,
  selectFinancialClarityRollout,
  selectQuickAddEnabled,
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

describe('Quick_Add_Flag reading', () => {
  it('is off when absent', () => {
    expect(readQuickAddFlag({})).toBe(false);
    expect(readQuickAddFlag({ VITE_QUICK_ADD_ENABLED: undefined })).toBe(false);
  });

  it('is off for an empty, malformed, or non-string value', () => {
    const values: unknown[] = [
      '', ' ', 'yes', 'on', 'enabled', '0', 'false', '2', '-1', '01', 'tru', 'true1',
      '1 1', 'true,false', 'ｔｒｕｅ', null, 0, 1, true, false, {}, ['true'],
    ];
    for (const value of values) {
      expect(readQuickAddFlag({ VITE_QUICK_ADD_ENABLED: value })).toBe(false);
    }
  });

  it('is on for 1 and true in any letter case, ignoring surrounding whitespace', () => {
    for (const value of ['1', 'true', 'TRUE', 'True', 'tRuE', ' true ', '\t1\n']) {
      expect(readQuickAddFlag({ VITE_QUICK_ADD_ENABLED: value })).toBe(true);
    }
  });

  it('does not read the Rollout_Flag variable', () => {
    expect(readQuickAddFlag({ VITE_FINANCIAL_CLARITY_ENABLED: 'true' })).toBe(false);
    expect(readClientFeatureFlags({ VITE_QUICK_ADD_ENABLED: 'true' })).toEqual({
      financialClarityEnabled: false,
    });
  });
});

describe('Quick_Add_Enabled', () => {
  const ON = 'true';

  it('is off when neither flag is set', () => {
    expect(selectQuickAddEnabled({})).toBe(false);
  });

  it('is off while the Rollout_Flag is off, whatever the Quick_Add_Flag says', () => {
    for (const rollout of [undefined, '', 'false', 'yes']) {
      expect(selectQuickAddEnabled({
        VITE_FINANCIAL_CLARITY_ENABLED: rollout,
        VITE_QUICK_ADD_ENABLED: ON,
      })).toBe(false);
    }
  });

  it('is off while the Quick_Add_Flag is off, whatever the Rollout_Flag says', () => {
    for (const quickAdd of [undefined, '', 'false', 'yes', 0]) {
      expect(selectQuickAddEnabled({
        VITE_FINANCIAL_CLARITY_ENABLED: ON,
        VITE_QUICK_ADD_ENABLED: quickAdd,
      })).toBe(false);
    }
  });

  it('is on only when both flags are on, in any accepted form', () => {
    for (const [rollout, quickAdd] of [['true', '1'], ['1', 'TRUE'], [' True ', ' true ']]) {
      expect(selectQuickAddEnabled({
        VITE_FINANCIAL_CLARITY_ENABLED: rollout,
        VITE_QUICK_ADD_ENABLED: quickAdd,
      })).toBe(true);
    }
  });

  it('leaves the Rollout_Flag selection unchanged', () => {
    expect(selectFinancialClarityRollout({ VITE_QUICK_ADD_ENABLED: ON })).toEqual({
      enabled: false,
      uiMode: 'legacy',
      readPath: 'legacy',
      contractVersion: null,
    });
    expect(selectFinancialClarityRollout({
      VITE_FINANCIAL_CLARITY_ENABLED: ON,
      VITE_QUICK_ADD_ENABLED: ON,
    })).toEqual({
      enabled: true,
      uiMode: 'clarity',
      readPath: 'clarity',
      contractVersion: '1',
    });
  });

  it('reads the build environment by default', () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', '');
    expect(selectQuickAddEnabled()).toBe(false);
    vi.stubEnv('VITE_QUICK_ADD_ENABLED', '1');
    expect(selectQuickAddEnabled()).toBe(true);
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    expect(selectQuickAddEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });
});
