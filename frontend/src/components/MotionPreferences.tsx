import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';

/**
 * Makes every Framer Motion animation in the app follow the device's reduced-motion setting
 * (Requirement 12.7). With `reducedMotion="user"` and the setting on, transform and layout
 * animations (slides, scales, springs, a bar growing from zero width) jump straight to their end
 * state; opacity changes still run. The global CSS rule in styles.css covers CSS animations and
 * transitions but cannot reach Framer Motion, which animates from JavaScript.
 *
 * One wrapper at the root covers the page transition, toasts, the insight list, and the
 * monthly history chart, so no component needs its own check.
 */
export function MotionPreferences({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
