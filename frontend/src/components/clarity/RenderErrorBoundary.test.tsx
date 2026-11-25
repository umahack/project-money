import { useQuery } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSettings, mockSettingsApi } from '../../test/dataUseFixtures';
import { axe, createTestQueryClient, createTestUser, renderAuthenticated } from '../../test/test-utils';
import { DataUseGateProvider } from '../../clarity/DataUseGateProvider';
import { Shell } from '../Shell';
import { RegionBoundary } from './RegionBoundary';
import { RENDER_FAILURE_CODE, RenderErrorBoundary } from './RenderErrorBoundary';

// Requirements 1.11-1.13, 9.11, 10.11, 10.15: a failed region, page, or app
// shows a fixed value-free message with one scoped retry and never blanks the
// page or navigation.

const SENTINEL_AMOUNT = '₹87,654.32';
const SENTINEL_NAME = 'Priya Sentinel Kumar';
const SENTINEL_URL = '/trips/4242?email=sentinel.person@example.test';

/** A render failure whose message carries values that must never be displayed. */
function hostileMessage(): string {
  return `render failed for ${SENTINEL_NAME} owing ${SENTINEL_AMOUNT} at ${SENTINEL_URL}`;
}

const control = { failing: true };

function Fragile({ label = 'content' }: { label?: string }): ReactElement {
  if (control.failing) throw new Error(hostileMessage());
  return <p>{label} is showing</p>;
}

// React rethrows a caught render error to the window in development builds, and
// jsdom would print it. These errors are the point of the test.
const swallowExpectedRenderError = (event: ErrorEvent) => event.preventDefault();

beforeEach(() => {
  control.failing = true;
  window.addEventListener('error', swallowExpectedRenderError);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  window.removeEventListener('error', swallowExpectedRenderError);
  delete document.documentElement.dataset.theme;
});

function expectFixedFailureText(container: HTMLElement): void {
  const text = container.textContent ?? '';
  expect(text).not.toContain(SENTINEL_AMOUNT);
  expect(text).not.toContain(SENTINEL_NAME);
  expect(text).not.toContain('sentinel.person');
  expect(text).not.toContain('4242');
  expect(text).toContain(`Error code: ${RENDER_FAILURE_CODE}`);
}

describe('RenderErrorBoundary in a region', () => {
  it('contains a render error to its own region and keeps the sibling region and page visible', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <main>
        <h1>Goals page</h1>
        <RegionBoundary regionKey="goal-list" label="Goals" hasData onRetry={onRetry}>
          <Fragile label="goal list" />
        </RegionBoundary>
        <RegionBoundary regionKey="trip-balances" label="Trip balances" hasData>
          <p>Trip balances are showing</p>
        </RegionBoundary>
      </main>,
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Goals could not be displayed.')).toBeInTheDocument();
    expect(alert).toHaveAttribute('data-error-code', RENDER_FAILURE_CODE);
    expect(alert).toHaveAttribute('data-render-failure', 'region');
    expectFixedFailureText(container);
    // Only the failed region is replaced.
    expect(screen.getByRole('heading', { name: 'Goals page' })).toBeInTheDocument();
    expect(screen.getByText('Trip balances are showing')).toBeInTheDocument();
    expect(screen.queryByText('goal list is showing')).toBeNull();
    expect(screen.getAllByRole('button', { name: /retry/i })).toHaveLength(1);

    control.failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry showing Goals' }));

    expect(await screen.findByText('goal list is showing')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Focus returns to the region instead of the page body.
    expect(screen.getByRole('group', { name: 'Goals' })).toHaveFocus();
    expect(screen.getByText('Trip balances are showing')).toBeInTheDocument();
  });

  it('shows the failure again, still scoped, when the retry also fails', async () => {
    const user = userEvent.setup();
    render(
      <>
        <RegionBoundary regionKey="a" label="Goals" hasData><Fragile /></RegionBoundary>
        <RegionBoundary regionKey="b" label="Trips" hasData><p>trips showing</p></RegionBoundary>
      </>,
    );
    await user.click(await screen.findByRole('button', { name: 'Retry showing Goals' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('trips showing')).toBeInTheDocument();
  });

  it('keeps the last confirmed data in the cache while a region fails and after it retries', async () => {
    const user = userEvent.setup();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(['goal', 17], { dataVersion: 7, savedMinor: 25_000 });
    function ConfirmedGoal() {
      const stored = useQuery({
        queryKey: ['goal', 17],
        queryFn: () => Promise.reject(new Error('unused')),
        enabled: false,
      });
      return stored.data ? <Fragile label="saved goal" /> : null;
    }
    renderAuthenticated(
      <RegionBoundary regionKey="goal:17" label="Goal" hasData><ConfirmedGoal /></RegionBoundary>,
      { queryClient },
    );
    await screen.findByRole('alert');
    expect(queryClient.getQueryData(['goal', 17])).toEqual({ dataVersion: 7, savedMinor: 25_000 });

    control.failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry showing Goal' }));
    expect(await screen.findByText('saved goal is showing')).toBeInTheDocument();
    expect(queryClient.getQueryData(['goal', 17])).toEqual({ dataVersion: 7, savedMinor: 25_000 });
  });

  it('does not render the error message even when the region is given no label detail', async () => {
    const { container } = render(
      <RenderErrorBoundary scope="region" label="Spending">
        <Fragile />
      </RenderErrorBoundary>,
    );
    await screen.findByRole('alert');
    expectFixedFailureText(container);
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('RenderErrorBoundary in the app shell', () => {
  function renderShell(route: string) {
    mockSettingsApi(buildSettings());
    function Broken(): ReactElement {
      return <Fragile label="broken page" />;
    }
    function Fine() {
      const [count, setCount] = useState(0);
      return (
        <>
          <h1>Spending page</h1>
          <button type="button" onClick={() => setCount((value) => value + 1)}>Add {count}</button>
        </>
      );
    }
    return renderAuthenticated(
      <Routes>
        <Route element={<DataUseGateProvider><Shell /></DataUseGateProvider>}>
          <Route path="/" element={<><h1>Home page</h1><Link to="/spending">Go to spending</Link></>} />
          <Route path="/broken" element={<Broken />} />
          <Route path="/spending" element={<Fine />} />
        </Route>
      </Routes>,
      { route, user: createTestUser() },
    );
  }

  it('keeps the primary navigation when a page throws, and clears when the user navigates', async () => {
    const user = userEvent.setup();
    const { container } = renderShell('/broken');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('This page could not be displayed.')).toBeInTheDocument();
    expect(alert).toHaveAttribute('data-render-failure', 'page');
    expectFixedFailureText(container);

    const sidebar = screen.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Home', 'Spending', 'Plan', 'Goals', 'Trips', 'Settings']) {
      expect(within(sidebar).getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }

    await user.click(within(sidebar).getByRole('link', { name: /Spending/ }));
    expect(await screen.findByRole('heading', { name: 'Spending page' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // The shell is the same document; nothing reloaded.
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: /Home/ })).toBeInTheDocument();
  });

  it('retries in place and moves focus to the main area instead of the page body', async () => {
    const user = userEvent.setup();
    renderShell('/broken');
    await screen.findByRole('alert');
    control.failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry showing This page' }));
    expect(await screen.findByText('broken page is showing')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('main')).toHaveFocus());
  });

  describe.each(['light', 'dark'] as const)('axe in the %s theme', (theme) => {
    it('has no violations for the region, page, and app failure states', async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <main>
          <RenderErrorBoundary scope="region" label="Goals"><Fragile /></RenderErrorBoundary>
          <RenderErrorBoundary scope="page" label="This page"><Fragile /></RenderErrorBoundary>
          <RenderErrorBoundary scope="app" label="Project Money"><Fragile /></RenderErrorBoundary>
        </main>,
      );
      await screen.findAllByRole('alert');
      expect(screen.getAllByRole('alert')).toHaveLength(3);
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

describe('RenderErrorBoundary reset keys', () => {
  it('clears a failed boundary when a reset key changes', async () => {
    function Harness() {
      const [path, setPath] = useState('/broken');
      return (
        <>
          <button type="button" onClick={() => { control.failing = false; setPath('/fine'); }}>Navigate</button>
          <RenderErrorBoundary scope="page" label="This page" resetKeys={[path]}>
            <Fragile label={path} />
          </RenderErrorBoundary>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(await screen.findByText('/fine is showing')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
