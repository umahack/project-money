import { render, screen, waitFor } from '@testing-library/react';
import { motion } from 'framer-motion';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionPreferences } from './MotionPreferences';

function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: reduce && /prefers-reduced-motion/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** A box that starts 120 px to the right and 14 px down and is told to animate home, as the page transition does. */
function Slider() {
  return <motion.div data-testid="slider" initial={{ opacity: 0, x: 120, y: 14 }} animate={{ opacity: 1, x: 0, y: 0 }} transition={{ duration: 5 }} />;
}

// Framer Motion reads the media query once per module instance, so this file only exercises the "reduce" setting.
describe('MotionPreferences (Requirement 12.7)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The slide lasts 5 seconds, so a box still translated 300 ms in is mid-slide.
  const afterAWhile = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

  it('places movement at its end state at once when the device asks for reduced motion', async () => {
    setReducedMotion(true);
    render(<MotionPreferences><Slider /></MotionPreferences>);
    await waitFor(() => expect(screen.getByTestId('slider').style.transform).toBe('none'));
  });

  it('without the wrapper, the same slide ignores the reduced-motion setting', async () => {
    setReducedMotion(true);
    render(<Slider />);
    await afterAWhile();
    expect(screen.getByTestId('slider').style.transform).toContain('translateX(');
  });

  it('is applied once at the root of the app, above every router, provider, and page', () => {
    const entry = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main.tsx'), 'utf8');
    const open = entry.indexOf('<MotionPreferences>');
    expect(open, 'main.tsx wraps the app in MotionPreferences').toBeGreaterThan(-1);
    expect(open).toBeLessThan(entry.indexOf('<BrowserRouter>'));
    expect(entry.indexOf('</MotionPreferences>')).toBeGreaterThan(entry.indexOf('</BrowserRouter>'));
  });
});
