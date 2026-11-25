import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { popOverlay, topOverlay } from '../native/backButton';
import { Modal } from './ui';

function drainOverlays() {
  for (let top = topOverlay(); top; top = topOverlay()) popOverlay(top.id);
}

/** What the hardware back button does with the top overlay when the policy says `close-overlay`. */
function pressBack(): 'closed' | 'consumed' | 'none' {
  const top = topOverlay();
  if (!top) return 'none';
  if (!top.closable) return 'consumed';
  act(() => top.onClose());
  return 'closed';
}

afterEach(() => {
  drainOverlays();
});

describe('Modal registers as a back-button overlay', () => {
  it('registers while open and unregisters when closed', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open={false} onClose={onClose} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toBeUndefined();

    rerender(<Modal open onClose={onClose} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toMatchObject({ closable: true });

    rerender(<Modal open={false} onClose={onClose} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toBeUndefined();
  });

  it('calls the same onClose that Escape uses when the overlay is closed', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="One"><p>body</p></Modal>);
    expect(pressBack()).toBe('closed');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls the latest onClose when the parent passes a new function each render, without moving in the stack', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Modal open onClose={first} title="One"><p>body</p></Modal>);
    const entry = topOverlay();
    rerender(<Modal open onClose={second} title="One"><p>body</p></Modal>);
    expect(topOverlay()?.id).toBe(entry?.id);
    pressBack();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('registers a locked modal as not closable, so Back is consumed and onClose never runs', () => {
    const onClose = vi.fn();
    render(<Modal open locked onClose={onClose} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toMatchObject({ closable: false });
    expect(pressBack()).toBe('consumed');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('follows `locked` while open, keeping the same entry', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open onClose={onClose} title="One"><p>body</p></Modal>);
    const id = topOverlay()?.id;
    rerender(<Modal open locked onClose={onClose} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toMatchObject({ id, closable: false });
    rerender(<Modal open onClose={onClose} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toMatchObject({ id, closable: true });
  });

  it('unregisters when unmounted while open', () => {
    const { unmount } = render(<Modal open onClose={() => undefined} title="One"><p>body</p></Modal>);
    expect(topOverlay()).toBeDefined();
    unmount();
    expect(topOverlay()).toBeUndefined();
  });

  it('gives each open modal its own entry, and two stacked modals close top-first', async () => {
    function Stack() {
      const [lower, setLower] = useState(true);
      const [upper, setUpper] = useState(true);
      return (
        <>
          <Modal open={lower} onClose={() => setLower(false)} title="Lower"><p>lower body</p></Modal>
          <Modal open={upper} onClose={() => setUpper(false)} title="Upper"><p>upper body</p></Modal>
        </>
      );
    }
    render(<Stack />);
    expect(screen.getByRole('dialog', { name: 'Lower' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Upper' })).toBeInTheDocument();

    // The modal opened last is the top entry, so the first Back closes only it.
    expect(pressBack()).toBe('closed');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Upper' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Lower' })).toBeInTheDocument();

    expect(pressBack()).toBe('closed');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lower' })).toBeNull());
    expect(topOverlay()).toBeUndefined();
  });

  it('a modal opened later sits above one already open, and a locked top modal blocks the one below', async () => {
    function Opened() {
      const [upper, setUpper] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setUpper(true)}>Open upper</button>
          <Modal open onClose={() => undefined} title="Lower"><p>lower body</p></Modal>
          <Modal open={upper} locked onClose={() => setUpper(false)} title="Upper"><p>upper body</p></Modal>
        </>
      );
    }
    render(<Opened />);
    expect(topOverlay()).toMatchObject({ closable: true });
    act(() => screen.getByRole('button', { name: 'Open upper' }).click());
    await screen.findByRole('dialog', { name: 'Upper' });
    expect(topOverlay()).toMatchObject({ closable: false });
    expect(pressBack()).toBe('consumed');
    expect(screen.getByRole('dialog', { name: 'Upper' })).toBeInTheDocument();
  });
});
