// Haptics wrapper edge cases (task 5.8; Requirements 5.4, 5.5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireHaptic, type HapticKind } from './haptics';

const state = vi.hoisted(() => ({
  native: true,
  reduced: false,
  impact: vi.fn<(options: { style: string }) => Promise<void>>(),
}));

vi.mock('../platform', () => ({ isNativePlatform: () => state.native }));
vi.mock('../reducedMotion', () => ({ prefersReducedMotion: () => state.reduced }));
vi.mock('@capacitor/haptics', () => ({
  Haptics: { impact: state.impact },
  ImpactStyle: { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' },
}));

const KINDS: readonly HapticKind[] = ['save', 'undo'];

beforeEach(() => {
  state.native = true;
  state.reduced = false;
  state.impact.mockReset();
  state.impact.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).vibrate;
});

describe('fireHaptic', () => {
  it.each(KINDS)('resolves without throwing when the plugin rejects for %s', async (kind) => {
    state.impact.mockRejectedValue(new Error('Haptics unavailable'));
    await expect(fireHaptic(kind)).resolves.toBeUndefined();
    expect(state.impact).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when the plugin throws synchronously', async () => {
    state.impact.mockImplementation(() => { throw new Error('Plugin not implemented'); });
    await expect(fireHaptic('save')).resolves.toBeUndefined();
  });

  it('uses the light style for a save and a different, medium style for an undo', async () => {
    await fireHaptic('save');
    await fireHaptic('undo');
    expect(state.impact.mock.calls.map((call) => call[0]?.style)).toEqual(['LIGHT', 'MEDIUM']);
  });

  it('never calls navigator.vibrate, whatever the platform and motion setting', async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true });
    for (const native of [true, false]) {
      for (const reduced of [true, false]) {
        for (const kind of KINDS) {
          state.native = native;
          state.reduced = reduced;
          await fireHaptic(kind);
        }
      }
    }
    // A rejecting plugin does not fall back to the browser vibration either.
    state.native = true;
    state.reduced = false;
    state.impact.mockRejectedValue(new Error('Haptics unavailable'));
    await fireHaptic('save');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('does nothing on the web', async () => {
    state.native = false;
    await fireHaptic('save');
    expect(state.impact).not.toHaveBeenCalled();
  });

  it('does nothing when the operating system asks for reduced motion', async () => {
    state.reduced = true;
    await fireHaptic('undo');
    expect(state.impact).not.toHaveBeenCalled();
  });
});
