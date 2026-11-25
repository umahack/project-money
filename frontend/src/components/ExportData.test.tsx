import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ExportData } from './ExportData';
import { queueApiResponses, renderAuthenticated } from '../test/test-utils';

const exporter = vi.hoisted(() => ({ saveAndShare: vi.fn() }));
vi.mock('../native/exportFile', () => exporter);

describe('ExportData session expiry', () => {
  it('clears the session and announces expiry on a 401 before saveAndShare is reached', async () => {
    exporter.saveAndShare.mockReset();
    const expired = vi.fn();
    window.addEventListener('auth:expired', expired as EventListener);
    const fetchMock = queueApiResponses({ status: 401, body: { error: 'Token expired' } });
    renderAuthenticated(<ExportData />);

    await userEvent.setup().click(screen.getByRole('button', { name: /download expenses/i }));

    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    window.removeEventListener('auth:expired', expired as EventListener);
    expect((expired.mock.calls[0]?.[0] as CustomEvent).detail).toBe('Your session has ended. Please sign in again.');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/finance/export.csv'),
      expect.objectContaining({ headers: { Authorization: 'Bearer test.jwt.token' } }),
    );
    expect(sessionStorage.getItem('pm_token')).toBeNull();
    expect(sessionStorage.getItem('pm_user')).toBeNull();
    expect(exporter.saveAndShare).not.toHaveBeenCalled();
    expect(screen.queryByText(/shared|downloaded/i)).toBeNull();
  });
});
