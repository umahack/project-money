import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DangerZone } from './DangerZone';
import {
  axe,
  queueApiResponses,
  renderAuthenticated,
} from '../test/test-utils';

const SUPPORT = {
  email: 'hello@project-money.online',
  path: 'mailto:hello@project-money.online',
};

const EXPORT_FAILURE = {
  error: 'Account export was unsuccessful. Your records are unchanged.',
  code: 'EXPORT_FAILED',
  status: 'unsuccessful',
  failed_record_categories: [{
    key: 'product_measurement_events',
    description: 'Consent-gated Product Analytics events linked to the account.',
  }],
  retry: { method: 'GET', path: '/api/auth/export' },
  support: SUPPORT,
};

const DELETION_FAILURE = {
  error: 'Account deletion is incomplete. No account records were deleted.',
  code: 'ACCOUNT_DELETION_INCOMPLETE',
  status: 'incomplete',
  undeleted_record_categories: [
    { key: 'salary_entries', description: 'Confirmed monthly salary records.' },
    { key: 'trip_data', description: 'Owned trips, memberships, invitations, members, and shared expenses.' },
  ],
  retry: { method: 'DELETE', path: '/api/auth/account' },
  support: SUPPORT,
};

async function confirmDeletion(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /delete my account/i }));
  await user.type(screen.getByLabelText('Current password'), 'Account-controls-123!');
  await user.type(screen.getByLabelText('Type "DELETE" to confirm'), 'DELETE');
  await user.click(screen.getByRole('button', { name: 'Permanently delete my account' }));
}

describe('DangerZone failure containment', () => {
  it('shows a scoped unsuccessful-export retry and support path without clearing the account', async () => {
    const fetchMock = queueApiResponses(
      { status: 500, body: EXPORT_FAILURE },
      { status: 500, body: EXPORT_FAILURE },
    );
    const result = renderAuthenticated(<DangerZone />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /download my data/i }));

    const failure = await screen.findByRole('alert', { name: 'Export unsuccessful' });
    expect(within(failure).getByText(EXPORT_FAILURE.error)).toBeInTheDocument();
    expect(within(failure).getByText(/Product measurement events:/i)).toBeInTheDocument();
    expect(within(failure).getByRole('link', { name: /contact support/i })).toHaveAttribute(
      'href',
      SUPPORT.path,
    );
    expect(sessionStorage.getItem('pm_token')).toBe('test.jwt.token');
    expect(sessionStorage.getItem('pm_user')).not.toBeNull();

    await user.click(within(failure).getByRole('button', { name: 'Retry export' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/auth/export',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test.jwt.token' },
      }),
    );
    expect(await axe(result.container)).toHaveNoViolations();
  });

  it('shows every undeleted category and keeps the rolled-back account active for retry', async () => {
    const fetchMock = queueApiResponses(
      { status: 500, body: DELETION_FAILURE },
      { status: 500, body: DELETION_FAILURE },
    );
    const result = renderAuthenticated(<DangerZone />);
    const user = userEvent.setup();

    await confirmDeletion(user);

    const failure = await screen.findByRole('alert', { name: 'Account deletion incomplete' });
    expect(within(failure).getByText(DELETION_FAILURE.error)).toBeInTheDocument();
    expect(within(failure).getByText(/account is still active, and your records remain unchanged/i)).toBeInTheDocument();
    expect(within(failure).getByText(/Salary entries:/i)).toBeInTheDocument();
    expect(within(failure).getByText(/Trip data:/i)).toBeInTheDocument();
    expect(within(failure).getByRole('link', { name: /contact support/i })).toHaveAttribute(
      'href',
      SUPPORT.path,
    );
    expect(screen.getByLabelText('Current password')).toHaveValue('Account-controls-123!');
    expect(screen.getByLabelText('Type "DELETE" to confirm')).toHaveValue('DELETE');
    expect(sessionStorage.getItem('pm_token')).toBe('test.jwt.token');
    expect(sessionStorage.getItem('pm_user')).not.toBeNull();

    await user.click(within(failure).getByRole('button', { name: 'Retry account deletion' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/auth/account',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer test.jwt.token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword: 'Account-controls-123!' }),
      }),
    );
    expect(sessionStorage.getItem('pm_token')).toBe('test.jwt.token');
    expect(await axe(result.container)).toHaveNoViolations();
  });

  it('clears the local account only after deletion succeeds', async () => {
    const fetchMock = queueApiResponses({ status: 200, body: { ok: true } });
    renderAuthenticated(<DangerZone />);
    const user = userEvent.setup();

    await confirmDeletion(user);

    await waitFor(() => expect(sessionStorage.getItem('pm_token')).toBeNull());
    expect(sessionStorage.getItem('pm_user')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Quick Add's category memory is one more record category of the account (Requirements 6.15 to 6.17): when export or
// deletion cannot cover it, it is named like any other category, with the server's plain-language description.
const MEMORY_DESCRIPTION = 'Remembered category choices used to suggest a category for notes you type in Quick Add.';
describe('DangerZone with category memory', () => {
  it('names category memory when an export is unsuccessful, beside the other categories', async () => {
    const payload = {
      ...EXPORT_FAILURE,
      failed_record_categories: [
        ...EXPORT_FAILURE.failed_record_categories,
        { key: 'category_memory', description: MEMORY_DESCRIPTION },
      ],
    };
    queueApiResponses({ status: 500, body: payload });
    const result = renderAuthenticated(<DangerZone />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /download my data/i }));
    const failure = await screen.findByRole('alert', { name: 'Export unsuccessful' });
    expect(within(failure).getByText(/Product measurement events:/i)).toBeInTheDocument();
    const memory = within(failure).getByText(/Category memory:/i).closest('li') as HTMLElement;
    expect(memory).toHaveTextContent(MEMORY_DESCRIPTION);
    expect(within(failure).getAllByRole('listitem')).toHaveLength(2);
    expect(await axe(result.container)).toHaveNoViolations();
  });

  it('reports category memory as an undeleted record category and keeps the account for a retry', async () => {
    const payload = {
      ...DELETION_FAILURE,
      undeleted_record_categories: [{ key: 'category_memory', description: MEMORY_DESCRIPTION }],
    };
    queueApiResponses({ status: 500, body: payload });
    const result = renderAuthenticated(<DangerZone />);
    const user = userEvent.setup();
    await confirmDeletion(user);
    const failure = await screen.findByRole('alert', { name: 'Account deletion incomplete' });
    const memory = within(failure).getByText(/Category memory:/i).closest('li') as HTMLElement;
    expect(memory).toHaveTextContent(MEMORY_DESCRIPTION);
    expect(within(failure).getAllByRole('listitem')).toHaveLength(1);
    expect(within(failure).getByRole('button', { name: 'Retry account deletion' })).toBeEnabled();
    expect(sessionStorage.getItem('pm_token')).toBe('test.jwt.token');
    expect(await axe(result.container)).toHaveNoViolations();
  });
});

