import fc from 'fast-check';
import { beforeEach, describe, it, vi } from 'vitest';
import { assertProperty } from '../test/propertyReport';
import type { HapticKind } from './haptics';

const state = vi.hoisted(() => ({
  native: false,
  reduced: false,
  /** Times the plugin module factory ran, which is once per import after `vi.resetModules()`. */
  imports: 0,
  impact: vi.fn<(options: { style: string }) => Promise<void>>(),
}));

vi.mock('../platform', () => ({ isNativePlatform: () => state.native }));
vi.mock('../reducedMotion', () => ({ prefersReducedMotion: () => state.reduced }));

const kinds = fc.constantFrom<HapticKind>('save', 'undo');
const EXPECTED_STYLE: Record<HapticKind, string> = { save: 'LIGHT', undo: 'MEDIUM' };

/** A fresh copy of the module under test, so the plugin import count starts at zero for each case. */
async function freshFireHaptic() {
  vi.resetModules();
  state.imports = 0;
  // Registered again for each case, so the factory runs once per import of the plugin module.
  vi.doMock('@capacitor/haptics', () => {
    state.imports += 1;
    return {
      Haptics: { impact: state.impact },
      ImpactStyle: { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' },
    };
  });
  state.impact.mockReset();
  state.impact.mockResolvedValue(undefined);
  return (await import('./haptics')).fireHaptic;
}

beforeEach(() => {
  state.native = false;
  state.reduced = false;
});

describe('haptic feedback properties', () => {
  // Feature: android-app-release, Property 5: Haptic feedback fires exactly on native, non-reduced-motion saves and undos, with distinct kinds
  // **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
  it('calls the plugin exactly once with the kind\'s style when native and not reduced, and never otherwise', async () => {
    await assertProperty(
      fc.asyncProperty(fc.boolean(), fc.boolean(), kinds, async (isNative, reducedMotion, kind) => {
        const fireHaptic = await freshFireHaptic();
        state.native = isNative;
        state.reduced = reducedMotion;

        await fireHaptic(kind);

        if (isNative && !reducedMotion) {
          return state.imports === 1
            && state.impact.mock.calls.length === 1
            && state.impact.mock.calls[0]?.[0]?.style === EXPECTED_STYLE[kind];
        }
        // On the web, or with reduced motion, the plugin is neither called nor imported.
        return state.imports === 0 && state.impact.mock.calls.length === 0;
      }),
    );
  });

  // Feature: android-app-release, Property 5: Haptic feedback fires exactly on native, non-reduced-motion saves and undos, with distinct kinds
  // **Validates: Requirements 5.1, 5.2**
  it('requests a different style for a save than for an undo', async () => {
    await assertProperty(
      fc.asyncProperty(fc.constant(true), async () => {
        const fireHaptic = await freshFireHaptic();
        state.native = true;
        state.reduced = false;

        await fireHaptic('save');
        await fireHaptic('undo');

        const styles = state.impact.mock.calls.map((call) => call[0]?.style);
        return styles.length === 2 && styles[0] !== styles[1];
      }),
    );
  });
});
