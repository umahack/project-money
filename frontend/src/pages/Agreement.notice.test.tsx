import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { installAgreementNetwork, renderAgreement } from '../test/agreementHarness';
import { buildSettings } from '../test/claritySettingsBuilder';
import { axe, createApiResponse } from '../test/test-utils';

// The notice content, the acknowledge flow, and the Product Analytics wording that used to be asserted
// against the inline DataUseGate card (components/clarity/dataUseGate.test.tsx). The page's loading, error,
// focus, sizing, and in-flight behaviour is in Agreement.test.tsx, and "agree navigates to the recorded
// destination" is Property 4 in Agreement.property.test.tsx, so none of that is repeated here.

const FROM = { pathname: '/spending', search: '' };
const AGREE = { name: 'I agree and continue' };

/** Opens "Read full details" and returns the region it reveals. */
async function openFullDetails(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const toggle = await screen.findByRole('button', { name: 'Read full details' });
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!region) throw new Error('The full details region is missing');
  return region;
}

describe('Agreement page notice content', () => {
  it('reveals the full notice in "Read full details": categories, outcomes, roles, retention, sharing, and controls', async () => {
    const user = userEvent.setup();
    installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: FROM });

    const toggle = await screen.findByRole('button', { name: 'Read full details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Salary' })).toBeNull();

    const details = await openFullDetails(user);
    expect(within(details).getByRole('heading', { name: /How Project Money uses your data/ })).toBeInTheDocument();
    // Categories, outcomes (with a first-use definition), access roles, retention, sharing.
    expect(within(details).getByRole('heading', { name: 'Salary' })).toBeInTheDocument();
    expect(within(details).getByText(/Disposable income: the pay left after your monthly bills/)).toBeInTheDocument();
    expect(within(details).getAllByText('Disposable income')).toHaveLength(1); // defined once, then named only
    expect(within(details).getAllByText('You, the account owner').length).toBeGreaterThan(0);
    expect(within(details).getByText('Accepted trip members, for shared trip fields only')).toBeInTheDocument();
    expect(within(details).getAllByText('Kept until you delete your account').length).toBeGreaterThan(0);
    expect(within(details).getByText(/A separate confirmation, after you review the disclosed fields/)).toBeInTheDocument();
    // Correction, export, deletion, and Product Analytics controls are listed.
    expect(within(details).getByText(/Your earlier confirmed value stays until the correction succeeds/)).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: 'Export your data' })).toHaveAttribute('href', '/settings');
    expect(within(details).getByRole('link', { name: 'Delete your account and data' })).toHaveAttribute('href', '/settings');
    expect(within(details).getAllByText(/It never includes financial amounts, free-text notes/).length).toBeGreaterThan(0);

    // Collapsing hides it again.
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('heading', { name: 'Salary' })).toBeNull();
  });

  it('renders server-provided notice text as plain text, never as markup', async () => {
    const user = userEvent.setup();
    const settings = buildSettings();
    settings.dataUseNotice.categories[0]!.purposes = ['<img src=x onerror=alert(1)> and <b>bold</b>'];
    installAgreementNetwork({ settings });
    renderAgreement({ from: FROM });

    const details = await openFullDetails(user);
    expect(within(details).getByText('<img src=x onerror=alert(1)> and <b>bold</b>')).toBeInTheDocument();
    expect(document.querySelector('.agreement img, .agreement b')).toBeNull();
  });

  it('says the notice changed when the user acknowledged an earlier version', async () => {
    const settings = buildSettings({ acknowledgedVersion: 1 });
    settings.dataUseNotice.version = 2;
    settings.dataUseNotice.acknowledgementRequired = true;
    installAgreementNetwork({ settings });
    renderAgreement({ from: FROM });

    expect(await screen.findByText(/The notice changed since you last acknowledged it/)).toBeInTheDocument();
  });

  it('does not say the notice changed on a first acknowledgement', async () => {
    installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: FROM });

    await screen.findByRole('button', AGREE);
    expect(screen.queryByText(/The notice changed since you last acknowledged it/)).toBeNull();
  });
});

describe('Agreement page acknowledgement failure', () => {
  it('shows a text error, keeps the page, and succeeds on "Try again"', async () => {
    const user = userEvent.setup();
    const network = installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: { pathname: '/spending', search: '?month=2026-01' } });
    const primary = await screen.findByRole('button', AGREE);

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      createApiResponse({ status: 500, body: { error: { code: 'SERVER', message: 'The server had a problem.' } } }),
    );
    await user.click(primary);

    const alert = await screen.findByText(/Your acknowledgement was not saved/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/agreement');
    expect(screen.queryByTestId('landed')).toBeNull();
    expect(screen.getByRole('button', AGREE)).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByTestId('landed');
    expect(screen.getByTestId('location')).toHaveTextContent('/spending?month=2026-01');
    // Only the notice version is acknowledged. The failed first request never reached the recorder.
    expect(network.patches()).toEqual([{ acknowledgedNoticeVersion: 1 }]);
  });
});

describe('Agreement page Product Analytics control', () => {
  it('is off and explains that agreeing to the notice comes first', async () => {
    installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: FROM });

    await screen.findByRole('button', AGREE);
    const toggle = screen.getByRole('checkbox', { name: /Product Analytics/ });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Agree to the data-use notice to turn it on/);
  });
});

describe('Agreement page keyboard operation', () => {
  it('reaches every control in reading order, operates the disclosure, and agrees with Enter', async () => {
    const user = userEvent.setup();
    const network = installAgreementNetwork({ settings: buildSettings() });
    renderAgreement({ from: FROM });
    const heading = await screen.findByRole('heading', { level: 1 });
    await screen.findByRole('button', AGREE);
    expect(heading).toHaveFocus();

    // Reading order: the disclosure, the legal links, then the primary and secondary controls.
    // The Product Analytics checkbox is disabled until the notice is agreed to, so it is skipped.
    await user.tab();
    const toggle = screen.getByRole('button', { name: 'Read full details' });
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.tab();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', AGREE)).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Not now, just look around' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', AGREE)).toHaveFocus();

    await user.keyboard('{Enter}');
    await screen.findByTestId('landed');
    expect(network.patches()).toEqual([{ acknowledgedNoticeVersion: 1 }]);
    expect(screen.getByTestId('location')).toHaveTextContent('/spending');
  });
});

describe('Agreement page accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations in %s theme (collapsed and with full details)', async (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      const user = userEvent.setup();
      installAgreementNetwork({ settings: buildSettings() });
      const view = renderAgreement({ from: FROM });

      await screen.findByRole('button', AGREE);
      expect(await axe(view.container)).toHaveNoViolations();

      await openFullDetails(user);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Salary' })).toBeInTheDocument());
      expect(await axe(view.container)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});
