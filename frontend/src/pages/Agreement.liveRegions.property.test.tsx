import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installAgreementNetwork, renderAgreement } from '../test/agreementHarness';
import { buildSettings } from '../test/claritySettingsBuilder';
import { assertProperty } from '../test/propertyReport';
import { fc } from '../test/test-utils';

/**
 * Feature: data-use-agreement-page, Property 11: Every message the Agreement_Page shows uses the correct live region role
 *
 * **Validates: Requirements 8.4**
 *
 * Each message-producing state of the page is driven for real (the page, both providers, the router, and the
 * settings client are real; only the network is replaced). For the message the state shows, the nearest ancestor
 * with a `role` must be `status` for an informational message and `alert` for an error message. As a cross-check,
 * an error is never placed in the page's status region, and an informational state shows no alert.
 */

type MessageState =
  | 'checkingSettings'
  | 'acknowledging'
  | 'acknowledgeFailed'
  | 'settingsFailedToLoad'
  | 'analyticsChangeFailed';

interface Expectation {
  /** Text of the message the state shows. */
  message: RegExp;
  role: 'status' | 'alert';
}

const EXPECTATIONS: Record<MessageState, Expectation> = {
  checkingSettings: { message: /Checking your data-use settings/, role: 'status' },
  acknowledging: { message: /Saving your acknowledgement/, role: 'status' },
  acknowledgeFailed: { message: /Your acknowledgement was not saved, so try again/, role: 'alert' },
  settingsFailedToLoad: { message: /Your data-use settings could not be loaded/, role: 'alert' },
  analyticsChangeFailed: { message: /The Product Analytics setting was not changed/, role: 'alert' },
};

const FROM = { pathname: '/spending', search: '' };
const WAIT = { timeout: 20_000 };

/** Brings the page into `state` and returns what is needed to release anything still held. */
async function drive(state: MessageState): Promise<{ release: () => void }> {
  switch (state) {
    case 'checkingSettings': {
      installAgreementNetwork({ settings: buildSettings(), get: 'pending' });
      renderAgreement({ from: FROM });
      return { release: () => {} };
    }
    case 'settingsFailedToLoad': {
      installAgreementNetwork({ settings: buildSettings(), get: 'error' });
      renderAgreement({ from: FROM });
      return { release: () => {} };
    }
    case 'acknowledging': {
      const network = installAgreementNetwork({ settings: buildSettings(), patch: 'hold' });
      renderAgreement({ from: FROM });
      fireEvent.click(await screen.findByRole('button', { name: 'I agree and continue' }, WAIT));
      return { release: network.release };
    }
    case 'acknowledgeFailed': {
      installAgreementNetwork({ settings: buildSettings(), patch: 'fail' });
      renderAgreement({ from: FROM });
      fireEvent.click(await screen.findByRole('button', { name: 'I agree and continue' }, WAIT));
      return { release: () => {} };
    }
    case 'analyticsChangeFailed': {
      // Turning Product Analytics off is allowed while the notice is required, so start from "on".
      installAgreementNetwork({ settings: buildSettings({ analyticsEnabled: true }), patch: 'fail' });
      renderAgreement({ from: FROM });
      const box = await screen.findByRole('checkbox', { name: /Product Analytics/ }, WAIT);
      await waitFor(() => expect(box).not.toBeDisabled(), WAIT);
      fireEvent.click(box);
      return { release: () => {} };
    }
  }
}

async function checkState(state: MessageState): Promise<void> {
  const { message, role } = EXPECTATIONS[state];
  let release: () => void = () => {};
  try {
    ({ release } = await drive(state));

    const element = await screen.findByText(message, undefined, WAIT);
    const page = document.querySelector('main.agreement');
    expect(page).not.toBeNull();
    expect(page?.contains(element)).toBe(true);

    // The message sits inside a live region of the right role (the element itself counts).
    const region = element.closest('[role]');
    expect(region, `${state}: no live region around the message`).not.toBeNull();
    expect(region?.getAttribute('role'), `${state}: wrong role`).toBe(role);
    expect(page?.contains(region)).toBe(true);

    const pageStatus = document.querySelector('p.agreement-status');
    expect(pageStatus).not.toBeNull();
    if (role === 'status') {
      // Informational: polite status region, and no error is showing.
      expect(region).toBe(pageStatus);
      expect(pageStatus).toHaveAttribute('aria-live', 'polite');
      expect(page?.querySelectorAll('[role="alert"]')).toHaveLength(0);
    } else {
      // Error: an alert region, and the polite status region does not carry the error text.
      expect(region).not.toBe(pageStatus);
      expect(pageStatus?.textContent ?? '').not.toMatch(message);
    }
  } finally {
    await act(async () => { release(); });
    cleanup();
  }
}

describe('Property 11: Every message the Agreement_Page shows uses the correct live region role', () => {
  it.each(Object.keys(EXPECTATIONS) as MessageState[])('uses the right role in the %s state', async (state) => {
    await checkState(state);
  }, 60_000);

  it('uses status for informational messages and alert for error messages in every message-producing state', async () => {
    await assertProperty(
      fc.asyncProperty(
        fc.constantFrom<MessageState>(
          'checkingSettings',
          'acknowledging',
          'acknowledgeFailed',
          'settingsFailedToLoad',
          'analyticsChangeFailed',
        ),
        async (state) => {
          await checkState(state);
        },
      ),
    );
  }, 300_000);
});
