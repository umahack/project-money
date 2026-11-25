import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { popOverlay, pushOverlay, topOverlay } from './backButton';
import { useBackButtonHandler } from './useBackButtonHandler';

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(() => false),
  addListener: vi.fn(),
  minimizeApp: vi.fn(),
  exitApp: vi.fn(),
  remove: vi.fn(),
  pluginLoads: 0,
}));

vi.mock('../platform', () => ({ isNativePlatform: () => mocks.isNative() }));
vi.mock('@capacitor/app', () => {
  mocks.pluginLoads += 1;
  return { App: { addListener: mocks.addListener, minimizeApp: mocks.minimizeApp, exitApp: mocks.exitApp } };
});

type BackListener = () => void;

function Probe({ mustAgree }: { mustAgree: boolean }) {
  useBackButtonHandler(mustAgree);
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function setup(mustAgree = false, entries = ['/'], index = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Probe mustAgree={mustAgree} />
    </MemoryRouter>,
  );
}

/** Waits for the dynamic import and listener registration, then returns the registered back-button callback. */
async function registeredListener(): Promise<BackListener> {
  await waitFor(() => expect(mocks.addListener).toHaveBeenCalledTimes(1));
  expect(mocks.addListener.mock.calls[0]?.[0]).toBe('backButton');
  return mocks.addListener.mock.calls[0]?.[1] as BackListener;
}

function drainOverlays() {
  for (let top = topOverlay(); top; top = topOverlay()) popOverlay(top.id);
}

beforeEach(() => {
  mocks.isNative.mockReset().mockReturnValue(false);
  mocks.addListener.mockReset().mockImplementation(() => Promise.resolve({ remove: mocks.remove }));
  mocks.minimizeApp.mockReset();
  mocks.exitApp.mockReset();
  mocks.remove.mockReset();
  window.history.replaceState(null, '');
});

afterEach(() => {
  drainOverlays();
});

describe('overlay registry', () => {
  it('has no top overlay when empty and ignores popping an unknown id', () => {
    expect(topOverlay()).toBeUndefined();
    popOverlay('missing');
    expect(topOverlay()).toBeUndefined();
  });

  it('pushes onto a stack: the last pushed is on top, and popping reveals the one below', () => {
    const a = { id: 'a', closable: true, onClose: vi.fn() };
    const b = { id: 'b', closable: false, onClose: vi.fn() };
    pushOverlay(a);
    pushOverlay(b);
    expect(topOverlay()).toBe(b);
    popOverlay('b');
    expect(topOverlay()).toBe(a);
    popOverlay('a');
    expect(topOverlay()).toBeUndefined();
  });

  it('pushing an existing id replaces that entry in place instead of stacking', () => {
    const first = { id: 'a', closable: true, onClose: vi.fn() };
    const other = { id: 'b', closable: true, onClose: vi.fn() };
    const replacement = { id: 'a', closable: false, onClose: vi.fn() };
    pushOverlay(first);
    pushOverlay(other);
    pushOverlay(replacement);
    // 'b' is still on top: the replacement kept the place of 'a'.
    expect(topOverlay()).toBe(other);
    popOverlay('b');
    expect(topOverlay()).toBe(replacement);
    popOverlay('a');
    expect(topOverlay()).toBeUndefined();
  });

  it('popping a middle entry keeps the order of the others', () => {
    const a = { id: 'a', closable: true, onClose: vi.fn() };
    const b = { id: 'b', closable: true, onClose: vi.fn() };
    const c = { id: 'c', closable: true, onClose: vi.fn() };
    pushOverlay(a);
    pushOverlay(b);
    pushOverlay(c);
    popOverlay('b');
    expect(topOverlay()).toBe(c);
    popOverlay('c');
    expect(topOverlay()).toBe(a);
  });
});

describe('useBackButtonHandler on the web', () => {
  it('registers no listener and never loads @capacitor/app when the runtime is not native', async () => {
    mocks.isNative.mockReturnValue(false);
    const { unmount } = setup();
    // Give a (wrongly) started dynamic import time to settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(mocks.pluginLoads).toBe(0);
    expect(mocks.addListener).not.toHaveBeenCalled();
    unmount();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe('useBackButtonHandler on native', () => {
  beforeEach(() => {
    mocks.isNative.mockReturnValue(true);
  });

  it('adds the backButton listener once, keeps it across navigation, and removes it on unmount', async () => {
    const { unmount } = setup(false, ['/', '/settings'], 1);
    await registeredListener();
    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
    unmount();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('removes a listener that finished registering after the component unmounted', async () => {
    let resolveHandle: (handle: { remove: () => void }) => void = () => undefined;
    mocks.addListener.mockImplementation(() => new Promise((resolve) => { resolveHandle = resolve; }));
    const { unmount } = setup();
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalledTimes(1));
    unmount();
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => { resolveHandle({ remove: mocks.remove }); });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('minimizes (never exits) on the home route', async () => {
    setup(false, ['/']);
    const press = await registeredListener();
    act(() => press());
    expect(mocks.minimizeApp).toHaveBeenCalledTimes(1);
    expect(mocks.exitApp).not.toHaveBeenCalled();
  });

  it('minimizes on /agreement while the gate requires acknowledgement, even with history', async () => {
    window.history.replaceState({ idx: 3 }, '');
    const { getByTestId } = setup(true, ['/', '/agreement'], 1);
    const press = await registeredListener();
    act(() => press());
    expect(mocks.minimizeApp).toHaveBeenCalledTimes(1);
    expect(mocks.exitApp).not.toHaveBeenCalled();
    expect(getByTestId('path').textContent).toBe('/agreement');
  });

  it('minimizes on another route with no in-app history', async () => {
    setup(false, ['/settings']);
    const press = await registeredListener();
    act(() => press());
    expect(mocks.minimizeApp).toHaveBeenCalledTimes(1);
    expect(mocks.exitApp).not.toHaveBeenCalled();
  });

  it('navigates back one entry on another route with in-app history', async () => {
    window.history.replaceState({ idx: 1 }, '');
    const { getByTestId } = setup(false, ['/', '/settings'], 1);
    const press = await registeredListener();
    expect(getByTestId('path').textContent).toBe('/settings');
    act(() => press());
    await waitFor(() => expect(getByTestId('path').textContent).toBe('/'));
    expect(mocks.minimizeApp).not.toHaveBeenCalled();
  });

  it('reads the latest route and gate without re-adding the listener', async () => {
    window.history.replaceState({ idx: 1 }, '');
    const view = setup(false, ['/', '/agreement'], 1);
    const press = await registeredListener();
    // The gate flips to required after registration. Unchanged, /agreement with history would navigate back.
    view.rerender(
      <MemoryRouter initialEntries={['/', '/agreement']} initialIndex={1}>
        <Probe mustAgree />
      </MemoryRouter>,
    );
    act(() => press());
    expect(mocks.minimizeApp).toHaveBeenCalledTimes(1);
    expect(mocks.addListener).toHaveBeenCalledTimes(1);
  });

  it('runs onClose of the top closable overlay and leaves the route alone', async () => {
    window.history.replaceState({ idx: 1 }, '');
    const onClose = vi.fn();
    const below = vi.fn();
    pushOverlay({ id: 'below', closable: true, onClose: below });
    pushOverlay({ id: 'top', closable: true, onClose });
    const { getByTestId } = setup(false, ['/', '/settings'], 1);
    const press = await registeredListener();
    act(() => press());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    expect(mocks.minimizeApp).not.toHaveBeenCalled();
    expect(getByTestId('path').textContent).toBe('/settings');
  });

  it('does nothing for a locked overlay: no close, no navigation, no minimize', async () => {
    window.history.replaceState({ idx: 1 }, '');
    const onClose = vi.fn();
    pushOverlay({ id: 'locked', closable: false, onClose });
    const { getByTestId } = setup(false, ['/', '/settings'], 1);
    const press = await registeredListener();
    act(() => press());
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.minimizeApp).not.toHaveBeenCalled();
    expect(mocks.exitApp).not.toHaveBeenCalled();
    expect(getByTestId('path').textContent).toBe('/settings');
  });
});
