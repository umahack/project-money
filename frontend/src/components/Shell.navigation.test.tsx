import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { buildSettings, mockSettingsApi } from '../test/dataUseFixtures';
import { createTestUser, renderAuthenticated } from '../test/test-utils';
import { Shell } from './Shell';

const USER_LABELS = ['Home', 'Spending', 'Plan', 'Goals', 'Trips', 'Settings'];
const ADMIN_LABELS = ['Overview', 'Users', 'Feedback', 'Traffic', 'Broadcast', 'My account'];

function renderShell(route = '/', { admin = false }: { admin?: boolean } = {}) {
  mockSettingsApi(buildSettings());
  return renderAuthenticated(
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<h1>Home page</h1>} />
        <Route path="/plan" element={<h1>Plan page</h1>} />
        <Route path="/trips" element={<h1>Trips page</h1>} />
        <Route path="/admin" element={<h1>Admin overview</h1>} />
        <Route path="/admin/users" element={<h1>Admin users</h1>} />
      </Route>
    </Routes>,
    { route, user: createTestUser({ is_admin: admin }) },
  );
}

const primary = () => screen.getByRole('navigation', { name: 'Primary' });
const labelsIn = (nav: HTMLElement) => within(nav).getAllByRole('link').map((link) => link.textContent?.replace(/^\p{Extended_Pictographic}\uFE0F?/u, ''));

describe('Shell header navigation (900px and wider)', () => {
  it('puts the primary navigation in the header with every destination', async () => {
    const { container } = renderShell();
    await screen.findByRole('heading', { name: 'Home page' });

    const header = container.querySelector('header.topbar') as HTMLElement;
    expect(header).toContainElement(primary());
    expect(primary()).toHaveClass('primary-nav', 'desktop-only');
    expect(labelsIn(primary())).toEqual(USER_LABELS);
    // The brand, the clock, the theme toggle, the greeting, and sign out stay in the same header.
    expect(within(header).getByRole('link', { name: /Project Money Beta/ })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
    expect(within(header).getByText(/^Hi, /)).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // No sidebar is rendered any more.
    expect(container.querySelector('aside, .sidebar, .side-link')).toBeNull();
  });

  it('keeps the mobile bottom bar as the navigation below 900px, with the same destinations', async () => {
    renderShell();
    await screen.findByRole('heading', { name: 'Home page' });

    const bottom = screen.getByRole('navigation', { name: 'Primary mobile' });
    expect(bottom).toHaveClass('bottom-tabs', 'mobile-only');
    for (const label of USER_LABELS) expect(bottom).toHaveTextContent(label);
    // Both navigations are in the page so CSS can show exactly one; their names differ.
    expect(primary()).not.toBe(bottom);
  });

  it('marks the current page with aria-current, and moves the mark when another page opens', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await screen.findByRole('heading', { name: 'Home page' });

    const home = within(primary()).getByRole('link', { name: 'Home' });
    const plan = within(primary()).getByRole('link', { name: 'Plan' });
    expect(home).toHaveAttribute('aria-current', 'page');
    expect(plan).not.toHaveAttribute('aria-current');
    // Exactly one link is marked, so the current page is never ambiguous.
    expect(within(primary()).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')).toHaveLength(1);

    await user.click(plan);
    expect(await screen.findByRole('heading', { name: 'Plan page' })).toBeInTheDocument();
    expect(plan).toHaveAttribute('aria-current', 'page');
    expect(home).not.toHaveAttribute('aria-current');
  });

  it('is reachable with Tab and followed with Enter, without a pointer', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await screen.findByRole('heading', { name: 'Home page' });

    const plan = within(primary()).getByRole('link', { name: 'Plan' });
    for (let stops = 0; stops < 12 && document.activeElement !== plan; stops += 1) await user.tab();
    expect(plan).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Plan page' })).toBeInTheDocument();
    expect(plan).toHaveAttribute('aria-current', 'page');
    // Focus stays on the navigation link that was used.
    expect(plan).toHaveFocus();
  });

  it('puts the navigation between the brand and the header actions in reading order', async () => {
    const { container } = renderShell();
    await screen.findByRole('heading', { name: 'Home page' });

    const brand = container.querySelector('header.topbar .brand') as HTMLElement;
    const actions = container.querySelector('header.topbar .top-actions') as HTMLElement;
    expect(brand.compareDocumentPosition(primary()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(primary().compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the admin items in the admin view and only the user items in the user view', async () => {
    const adminView = renderShell('/admin/users', { admin: true });
    await screen.findByRole('heading', { name: 'Admin users' });
    expect(labelsIn(primary())).toEqual(ADMIN_LABELS);
    expect(within(primary()).getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
    expect(within(primary()).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    adminView.unmount();

    renderShell('/', { admin: true });
    await screen.findByRole('heading', { name: 'Home page' });
    expect(labelsIn(primary())).toEqual(USER_LABELS);
    // The 🔄 switch in the header is how an admin moves between the two views.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to admin console' })).toBeInTheDocument());
  });
});
