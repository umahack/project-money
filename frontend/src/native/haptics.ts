import { isNativePlatform } from '../platform';
import { prefersReducedMotion } from '../reducedMotion';

export type HapticKind = 'save' | 'undo';

/**
 * Fires one haptic impulse for a confirmed Quick Add save or a completed undo.
 * It does nothing on the web, when the OS requests reduced motion, or when the plugin fails.
 * The plugin is imported only when an impulse is due, so the web never loads it.
 * `navigator.vibrate` is never used.
 */
export async function fireHaptic(kind: HapticKind): Promise<void> {
  if (!isNativePlatform() || prefersReducedMotion()) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: kind === 'save' ? ImpactStyle.Light : ImpactStyle.Medium });
  } catch {
    /* ignore: a haptic failure never affects the save or undo result */
  }
}
