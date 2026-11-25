import { isNativePlatform } from '../platform';

export type SystemBarTheme = 'light' | 'dark';

/**
 * Sets the colour of the status bar and navigation bar icons to match the app theme.
 *
 * Capacitor's `SystemBarsStyle` names describe the bar background, not the icons:
 *   - `Light` = dark icons on a light background (used by the light theme)
 *   - `Dark`  = light icons on a dark background (used by the dark theme)
 *
 * Edge-to-edge is enforced by Android at targetSdk 36, so the app draws behind the bars and cannot
 * (and does not try to) colour them with `StatusBar.setBackgroundColor`. Only the icon style is set.
 *
 * A no-op on the web. A native failure is logged and swallowed, because a wrong icon colour must
 * never break startup or a theme switch.
 */
export async function applySystemBarStyle(theme: SystemBarTheme): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
    await SystemBars.setStyle({ style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
  } catch (error) {
    console.warn('[capacitor] SystemBars.setStyle skipped:', error);
  }
}
