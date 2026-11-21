import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataUseGateProvider } from '../../clarity/DataUseGateProvider';
import { DATA_USE_REASON_ID, DataUseGate } from '../clarity';
import { deferred } from '../../test/clarity-fixtures';
import { buildSettings } from '../../test/dataUseFixtures';
import { jsonFailure, jsonOk, mockTripApi } from '../../test/tripFixtures';
import { axe, renderAuthenticated } from '../../test/test-utils';
import { TripShareLink } from '../TripShareLink';

const TRIP = 3;
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

/** What the server's `GET /trips/:id/share/disclosure` returns. The labels are deliberately unusual so a hand-written UI list could not match them. */
const DISCLOSURE = {
  version: 1,
  groups: [
    { id: 'trip', title: 'Trip details', fields: [{ path: 'trip.name', label: 'Zebra trip name' }, { path: 'trip.budget', label: 'Zebra budget' }] },
    { id: 'members', title: 'People', fields: [{ path: 'members[].name', label: 'Zebra member names' }] },
  ],
  private: ['Zebra salary and bills', 'Zebra email addresses'],
};

const publicLabels = DISCLOSURE.groups.flatMap((group) => group.fields.map((field) => field.label));

interface ServerLink { enabled: boolean; token: string | null }

/** A tiny in-memory share endpoint. `postOutcomes` decides each POST: applied+ok, applied but the response is lost, or rejected. */
function shareServer(
  initial: ServerLink = { enabled: false, token: null },
  postOutcomes: Array<'ok' | 'lost' | 'rejected'> = [],
) {
  const link = { ...initial };
  let posts = 0;
  const api = mockTripApi({
    [`GET /trips/${TRIP}/share`]: () => jsonOk({ enabled: link.enabled, token: link.enabled ? link.token : null }),
    [`GET /trips/${TRIP}/share/disclosure`]: DISCLOSURE,
    [`POST /trips/${TRIP}/share`]: () => {
      const outcome = postOutcomes[posts] ?? 'ok';
      posts += 1;
      if (outcome === 'rejected') return jsonFailure(500, { error: 'The server had a problem.' });
      link.enabled = true;
      link.token = initial.enabled ? TOKEN_B : TOKEN_A;
      if (outcome === 'lost') return jsonFailure(500, { error: 'The server had a problem.' });
      return jsonOk({ token: link.token });
    },
    [`DELETE /trips/${TRIP}/share`]: () => {
      link.enabled = false;
      link.token = null;
      return jsonOk({ ok: true });
    },
  });
  return { api, link };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const writes = (api: ReturnType<typeof mockTripApi>) => api.calls.filter((call) => call.method === 'POST' || call.method === 'DELETE');

beforeEach(() => {
  vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'true');
});

describe('creating a link', () => {
  it('is off by default and sends nothing until the owner confirms the exact public fields', async () => {
    const user = userEvent.setup();
    const { api } = shareServer();
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    expect(await screen.findByText(/Sharing is off\./)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Public link/ })).toBeNull();

    const trigger = button('Create public link');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Create a public link' });
    await within(dialog).findByText('Zebra trip name');
    expect(dialog).toHaveFocus();

    // Exactly the server's fields, grouped, and nothing the UI invented.
    const fields = within(dialog).getAllByRole('listitem').filter((item) => item.hasAttribute('data-field'));
    expect(fields.map((item) => item.textContent)).toEqual(publicLabels);
    expect(within(within(dialog).getByRole('list', { name: 'Trip details' })).getAllByRole('listitem')).toHaveLength(2);
    expect(within(dialog).getByRole('list', { name: 'People' })).toBeInTheDocument();
    const stays = within(dialog).getByRole('list', { name: 'Stays private' });
    expect(within(stays).getAllByRole('listitem').map((item) => item.textContent)).toEqual(DISCLOSURE.private);
    expect(dialog).toHaveTextContent('Anyone who has the link can view this trip.');
    expect(dialog).toHaveTextContent('Revoke link');
    expect(dialog).toHaveTextContent('Rotate link');
    expect(dialog).not.toHaveTextContent('previous link stops working');

    expect(writes(api)).toHaveLength(0);
    expect(api.to('GET', `/trips/${TRIP}/share/disclosure`)).toHaveLength(1);
  });

  it('cancel and Escape change nothing, send nothing, and return focus to the trigger', async () => {
    const user = userEvent.setup();
    const { api } = shareServer();
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    const trigger = await screen.findByRole('button', { name: 'Create public link' });

    await user.click(trigger);
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();

    expect(writes(api)).toHaveLength(0);
    expect(screen.getByText(/Sharing is off\./)).toBeInTheDocument();
  });

  it('keeps Tab inside the dialog and operates by keyboard', async () => {
    const user = userEvent.setup();
    const { api } = shareServer();
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Create public link' });
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.to('POST', `/trips/${TRIP}/share`)).toHaveLength(1));
  });

  it('confirming sends one request, shows scoped status, and moves focus to the new link', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const { api } = shareServer();
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        await pending.promise;
      }
      return original(input, init);
    });
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    const confirm = within(dialog).getByRole('button', { name: 'Create public link' });
    await user.dblClick(confirm);

    expect(await screen.findByText('Creating public link: pending')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    pending.resolve(new Response());

    const link = await screen.findByRole('textbox', { name: /Public link/ });
    expect(link).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_A}`);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(link).toHaveFocus();
    expect(screen.getByText('Public link created. Anyone with it can now view this trip.')).toBeInTheDocument();
    expect(api.to('POST', `/trips/${TRIP}/share`)).toHaveLength(1);
    expect(api.to('POST', `/trips/${TRIP}/share`)[0]?.headers['X-Clarity-Contract']).toBe('1');
  });

  it('retries a rejected create with the same request and shows the failure beside the control', async () => {
    const user = userEvent.setup();
    const { api } = shareServer({ enabled: false, token: null }, ['rejected', 'ok']);
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    await user.click(within(dialog).getByRole('button', { name: 'Create public link' }));

    const alert = await screen.findByText(/Creating public link: failed\./);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('The server had a problem.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/Sharing is off\./)).toBeInTheDocument();
    expect(writes(api)).toHaveLength(1);

    await user.click(button('Retry creating public link'));
    expect(await screen.findByRole('textbox', { name: /Public link/ })).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_A}`);
    expect(api.to('POST', `/trips/${TRIP}/share`)).toHaveLength(2);
  });

  it('does not create a second link when the failed attempt had already been applied', async () => {
    const user = userEvent.setup();
    const { api } = shareServer({ enabled: false, token: null }, ['lost']);
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    await user.click(within(dialog).getByRole('button', { name: 'Create public link' }));
    await screen.findByText(/Creating public link: failed\./);

    await user.click(button('Retry creating public link'));
    expect(await screen.findByRole('textbox', { name: /Public link/ })).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_A}`);
    expect(api.to('POST', `/trips/${TRIP}/share`)).toHaveLength(1);
  });

  it('cannot be confirmed while the public fields are unavailable, and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { api } = shareServer();
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/share/disclosure') && (attempts += 1) === 1) {
        return jsonFailure(500, { error: 'Disclosure unavailable.' });
      }
      return original(input, init);
    });
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Could not load the public fields/);
    expect(within(dialog).getByRole('button', { name: 'Create public link' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await within(dialog).findByText('Zebra trip name');
    expect(within(dialog).getByRole('button', { name: 'Create public link' })).toBeEnabled();
    expect(writes(api)).toHaveLength(0);
  });
});

describe('rotating a link', () => {
  it('shows the disclosure again, says the previous link stops working, and sends only on confirm', async () => {
    const user = userEvent.setup();
    const { api } = shareServer({ enabled: true, token: TOKEN_A });
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    const link = await screen.findByRole('textbox', { name: /Public link/ });
    expect(link).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_A}`);

    const trigger = button('Rotate link');
    await user.click(trigger);
    let dialog = await screen.findByRole('dialog', { name: 'Rotate the public link' });
    await within(dialog).findByText('Zebra trip name');
    expect(dialog).toHaveTextContent('The previous link stops working as soon as you confirm.');
    expect(within(dialog).getAllByRole('listitem').filter((item) => item.hasAttribute('data-field')).map((item) => item.textContent)).toEqual(publicLabels);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(writes(api)).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: /Public link/ })).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_A}`);

    await user.click(trigger);
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate link' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Public link/ })).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_B}`));
    expect(screen.getByText('Public link rotated. The previous link no longer works.')).toBeInTheDocument();
    expect(api.to('POST', `/trips/${TRIP}/share`)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button('Rotate link')).toHaveFocus();
  });

  it('does not rotate twice when the failed rotation had already been applied', async () => {
    const user = userEvent.setup();
    const { api } = shareServer({ enabled: true, token: TOKEN_A }, ['lost']);
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Rotate link' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Zebra trip name');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate link' }));
    await screen.findByText(/Rotating public link: failed\./);
    await user.click(button('Retry rotating public link'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Public link/ })).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_B}`));
    expect(api.to('POST', `/trips/${TRIP}/share`)).toHaveLength(1);
  });
});

describe('revoking a link', () => {
  it('is one action with no disclosure step, and keeps the page usable', async () => {
    const user = userEvent.setup();
    const { api, link } = shareServer({ enabled: true, token: TOKEN_A });
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke link' }));

    expect(await screen.findByText('Public link revoked. Your trip data is unchanged.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.to('GET', `/trips/${TRIP}/share/disclosure`)).toHaveLength(0);
    expect(api.to('DELETE', `/trips/${TRIP}/share`)).toHaveLength(1);
    expect(link.enabled).toBe(false);
    expect(screen.getByText(/Sharing is off\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Public share link/ })).toHaveFocus();
  });

  it('retries a failed revocation', async () => {
    const user = userEvent.setup();
    let deletes = 0;
    const { api } = shareServer({ enabled: true, token: TOKEN_A });
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE' && (deletes += 1) === 1) return jsonFailure(500, { error: 'The server had a problem.' });
      return original(input, init);
    });
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke link' }));
    await screen.findByText(/Revoking public link: failed\./);
    expect(screen.getByRole('textbox', { name: /Public link/ })).toBeInTheDocument();
    await user.click(button('Retry revoking public link'));
    expect(await screen.findByText('Public link revoked. Your trip data is unchanged.')).toBeInTheDocument();
    // The first DELETE was rejected before the in-memory server saw it; the retry is the second request.
    expect(deletes).toBe(2);
    expect(api.to('DELETE', `/trips/${TRIP}/share`)).toHaveLength(1);
  });
});

describe('data-use gate and flag', () => {
  it('pauses creating and rotating, but never revoking, until the notice is acknowledged', async () => {
    const user = userEvent.setup();
    const server = shareServer();
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => (
      String(input).endsWith('/clarity/settings') ? jsonOk(buildSettings()) : original(input, init)
    ));
    const view = renderAuthenticated(
      <DataUseGateProvider enabled>
        <DataUseGate />
        <TripShareLink tripId={TRIP} />
      </DataUseGateProvider>,
    );
    const create = await screen.findByRole('button', { name: 'Create public link' });
    await waitFor(() => expect(create).toBeDisabled());
    expect(create).toHaveAttribute('aria-describedby', DATA_USE_REASON_ID);
    expect(document.getElementById(DATA_USE_REASON_ID)).toHaveTextContent(/acknowledge the data-use notice/i);
    expect(writes(server.api)).toHaveLength(0);

    // An existing link can still be revoked.
    view.unmount();
    const enabled = shareServer({ enabled: true, token: TOKEN_A });
    const originalEnabled = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => (
      String(input).endsWith('/clarity/settings') ? jsonOk(buildSettings()) : originalEnabled(input, init)
    ));
    renderAuthenticated(
      <DataUseGateProvider enabled>
        <DataUseGate />
        <TripShareLink tripId={TRIP} />
      </DataUseGateProvider>,
    );
    const rotate = await screen.findByRole('button', { name: 'Rotate link' });
    await waitFor(() => expect(rotate).toBeDisabled());
    const revoke = screen.getByRole('button', { name: 'Revoke link' });
    expect(revoke).toBeEnabled();
    await user.click(revoke);
    await screen.findByText('Public link revoked. Your trip data is unchanged.');
    expect(enabled.api.to('DELETE', `/trips/${TRIP}/share`)).toHaveLength(1);
  });

  it('leaves the original card unchanged when the clarity flag is off', async () => {
    vi.stubEnv('VITE_FINANCIAL_CLARITY_ENABLED', 'false');
    const user = userEvent.setup();
    const { api } = shareServer();
    renderAuthenticated(<TripShareLink tripId={TRIP} />);
    expect(await screen.findByText(/Anyone with this link can view the trip \(members and settle-up\)/)).toBeInTheDocument();
    await user.click(button('Create public link'));
    expect(await screen.findByRole('textbox')).toHaveValue(`${window.location.origin}/share/trip/${TOKEN_A}`);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.to('GET', `/trips/${TRIP}/share/disclosure`)).toHaveLength(0);
    const [post] = api.to('POST', `/trips/${TRIP}/share`);
    expect(post?.headers['X-Clarity-Contract']).toBeUndefined();
    expect(button('Rotate')).toBeInTheDocument();
    expect(button('Disable')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations with the dialog closed and open in the %s theme', async (theme) => {
    const user = userEvent.setup();
    document.documentElement.dataset.theme = theme;
    try {
      shareServer({ enabled: true, token: TOKEN_A }, ['rejected']);
      const { container } = renderAuthenticated(<TripShareLink tripId={TRIP} />);
      await screen.findByRole('textbox', { name: /Public link/ });
      const rules = { rules: { 'heading-order': { enabled: false } } };
      expect(await axe(container, rules)).toHaveNoViolations();
      await user.click(button('Rotate link'));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Zebra trip name');
      expect(await axe(container, rules)).toHaveNoViolations();
      await user.click(within(dialog).getByRole('button', { name: 'Rotate link' }));
      await screen.findByText(/Rotating public link: failed\./);
      expect(await axe(container, rules)).toHaveNoViolations();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});
