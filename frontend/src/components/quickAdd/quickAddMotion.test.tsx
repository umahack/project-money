// Reduced motion for the Quick Add dialog (task 16.2; Requirements 12.10, 9.18).
//
// The dialog is the shared `Modal`, which animates with Framer Motion (a spring that scales and slides the box). A CSS
// rule cannot stop that, because Framer writes the transform inline, so the component itself has to read the device
// setting. With reduced motion the box may fade, but it never scales or slides.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../ui';

/**
 * One media-query object for `prefers-reduced-motion`. Framer Motion reads the setting once, from the first query
 * object it receives, and then follows that object's listeners, so every test must hand it the same one.
 */
const motionQuery = (() => {
  const listeners = new Set<() => void>();
  let reduced = false;
  return {
    get matches() { return reduced; },
    media: '(prefers-reduced-motion)',
    onchange: null,
    addListener: (listener: () => void) => { listeners.add(listener); },
    removeListener: (listener: () => void) => { listeners.delete(listener); },
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    dispatchEvent: () => false,
    set(next: boolean) {
      reduced = next;
      for (const listener of [...listeners]) listener();
    },
  };
})();

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => (
    /prefers-reduced-motion/.test(query)
      ? motionQuery
      : { matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }
  ));
  motionQuery.set(reduced);
}

function openDialog() {
  render(<Modal open onClose={() => undefined} title="Quick Add"><button type="button">Inside</button></Modal>);
  return screen.getByRole('dialog', { name: 'Quick Add' });
}

afterEach(() => motionQuery.set(false));

describe('the Quick Add dialog and the device motion setting', () => {
  it('scales and slides in when motion is allowed (the control for the next test)', () => {
    setReducedMotion(false);
    const style = openDialog().getAttribute('style') ?? '';
    expect(style).toMatch(/scale\(0\.92\)|translateY\(24px\)|translate3d|matrix/);
  });

  it('only fades in when the device asks for reduced motion: no scale, no slide', () => {
    setReducedMotion(true);
    const dialog = openDialog();
    const style = dialog.getAttribute('style') ?? '';
    expect(style).not.toMatch(/scale|translate|matrix/);
    expect(style).toMatch(/opacity:\s*0/);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
