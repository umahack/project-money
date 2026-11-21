import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Modal } from './ui';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      <button type="button">Behind the dialog</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Example dialog">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Modal>
    </div>
  );
}

describe('Modal keyboard behavior (Requirements 12.5 and 12.6)', () => {
  it('moves focus in, keeps Tab and Shift+Tab inside, closes on Escape, and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Example dialog' });
    expect(dialog).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    // Past the last control, Tab wraps to the first instead of reaching the page behind the dialog.
    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    // Shift+Tab from the dialog box itself wraps to the last control.
    dialog.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Behind the dialog' })).not.toHaveFocus();

    await user.keyboard('{Escape}');
    // The dialog leaves with a short exit animation.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });
});
