/**
 * Quick Add keyboard shortcut matcher and platform detection.
 *
 * The shortcut is Cmd + K on Apple platforms and Ctrl + K everywhere else. The matcher is a pure predicate over a
 * keyboard event shape. It does not call `preventDefault`, check for open modals, or read the DOM; the shortcut host
 * does that only after a match. `isApplePlatform` reads the browser's navigator, and takes an optional navigator-like
 * value so it can be tested without a browser.
 *
 * Requirements: 1.7, 1.15, 1.16, 1.18, 17.24.
 */

/** The subset of `KeyboardEvent` the matcher reads. Fields may be absent on synthetic or autofill events. */
export interface KeyEventLike {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** The subset of `navigator` that platform detection reads. */
export interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

const LATIN_LETTER = /^[a-z]$/i;
const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

/**
 * Whether the event is exactly the Quick Add shortcut for the platform.
 *
 * Accepts only when the platform's modifier (Meta on Apple platforms, Control elsewhere) is held, the other
 * platform's modifier is not, Shift and Alt are not held, the event is not a key repeat, no input method composition
 * is in progress, and the key is K. A Latin letter key matches by its value, so a Dvorak or AZERTY layout follows the
 * letter it types. Any other key value (a Hindi or Telugu layout) matches by the physical key code `KeyK`.
 */
export function matchQuickAddShortcut(e: KeyEventLike, apple: boolean): boolean {
  if (e.isComposing || e.repeat || e.shiftKey || e.altKey) return false;
  const modifier = apple ? Boolean(e.metaKey) && !e.ctrlKey : Boolean(e.ctrlKey) && !e.metaKey;
  if (!modifier) return false;
  const key = typeof e.key === 'string' ? e.key : '';
  return LATIN_LETTER.test(key) ? key.toLowerCase() === 'k' : e.code === 'KeyK';
}

/**
 * Whether the current platform is an Apple platform (macOS, iOS, iPadOS).
 *
 * Prefers `userAgentData.platform`, then `navigator.platform`, then the user agent. iPadOS in desktop mode reports
 * `MacIntel`, which counts as Apple. Returns false when no navigator is available (server rendering, tests).
 */
export function isApplePlatform(nav?: NavigatorLike | null): boolean {
  const source: NavigatorLike | undefined | null =
    nav === undefined ? (typeof navigator === 'undefined' ? undefined : navigator) : nav;
  if (!source) return false;
  const platform = [source.userAgentData?.platform, source.platform].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const text = platform ?? (typeof source.userAgent === 'string' ? source.userAgent : '');
  return APPLE_PLATFORM.test(text);
}
