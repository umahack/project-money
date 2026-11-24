import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuth } from '../../api';
import { FinancialClarityProvider } from '../FinancialClarityProvider';
import { MutationStatusProvider } from '../MutationStatusProvider';
import { notifyFinancialStateCleared } from '../stateLifecycle';
import { renderAuthenticated } from '../../test/test-utils';
import {
  QuickAddProvider,
  useCurrentAnswer,
  useQuickAddEntries,
  useQuickAddLine,
  useQuickAddStore,
  useSubmissionBlockedReason,
} from './QuickAddProvider';
import {
  SUBMISSION_BLOCKED_TEXT,
  UNDO_WINDOW_MS,
  createQuickAddStore,
  type NewEntryInput,
} from './quickAddStore';

const T0 = Date.parse('2026-01-15T06:30:00.000Z');

function newEntry(cid: string): NewEntryInput {
  return {
    cid,
    parsed: { amountMinor: 12000, spentOn: '2026-01-15', note: 'coffee' },
    suggestion: { category: 'Food', source: 'keyword', reason: 'Matched the word coffee.' },
    category: 'Food',
  };
}

function Probe() {
  const store = useQuickAddStore();
  const [line, setLine] = useQuickAddLine();
  const entries = useQuickAddEntries();
  const blocked = useSubmissionBlockedReason();
  const answer = useCurrentAnswer();
  return (
    <div>
      <label>
        Line
        <input value={line} onChange={(event) => setLine(event.target.value)} />
      </label>
      <output data-testid="phases">{entries.map((entry) => `${entry.cid}:${entry.phase}${entry.undo ? '+undo' : ''}`).join(',')}</output>
      <output data-testid="blocked">{blocked ?? 'open'}</output>
      <output data-testid="answer">{answer ? String(answer.dataVersion) : 'none'}</output>
      <button type="button" onClick={() => store.dispatch({ type: 'entry/submit', entry: newEntry(`e${entries.length + 1}`) })}>
        Add
      </button>
      <button type="button" onClick={() => store.dispatch({ type: 'entry/confirmed', cid: 'e1', expenseId: 5 })}>
        Confirm first
      </button>
    </div>
  );
}

function renderProbe(store = createQuickAddStore()) {
  return {
    store,
    ...renderAuthenticated(
      <FinancialClarityProvider>
        <MutationStatusProvider>
          <QuickAddProvider store={store}>
            <Probe />
          </QuickAddProvider>
        </MutationStatusProvider>
      </FinancialClarityProvider>,
    ),
  };
}

describe('QuickAddProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing of its own and shares the draft and entries through hooks', () => {
    const bare = render(
      <QuickAddProvider store={createQuickAddStore()}>
        <span data-testid="child">child</span>
      </QuickAddProvider>,
    );
    expect(bare.container.innerHTML).toBe('<span data-testid="child">child</span>');
    bare.unmount();

    renderProbe();
    act(() => {
      screen.getByRole('button', { name: 'Add' }).click();
    });
    expect(screen.getByTestId('phases')).toHaveTextContent('e1:pending');
    expect(screen.getByTestId('answer')).toHaveTextContent('none');
  });

  it('ends the Undo control by itself after 8 seconds without a reload or a request', () => {
    renderProbe();
    act(() => {
      screen.getByRole('button', { name: 'Add' }).click();
    });
    act(() => {
      screen.getByRole('button', { name: 'Confirm first' }).click();
    });
    expect(screen.getByTestId('phases')).toHaveTextContent('e1:saved+undo');
    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(screen.getByTestId('phases')).toHaveTextContent('e1:saved');
    expect(screen.getByTestId('phases')).not.toHaveTextContent('+undo');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('shows why submission is disabled once five entries are pending', () => {
    renderProbe();
    for (let count = 0; count < 5; count += 1) {
      act(() => {
        screen.getByRole('button', { name: 'Add' }).click();
      });
    }
    expect(screen.getByTestId('blocked')).toHaveTextContent(SUBMISSION_BLOCKED_TEXT);
    act(() => {
      screen.getByRole('button', { name: 'Add' }).click();
    });
    expect(screen.getByTestId('phases').textContent?.split(',')).toHaveLength(5);
  });

  it('discards the draft, the entries, and the timers when the financial state clears', () => {
    const { store } = renderProbe();
    const baseline = vi.getTimerCount();
    act(() => {
      store.dispatch({ type: 'line/set', line: '450 swiggy' });
      store.dispatch({ type: 'entry/submit', entry: newEntry('e1') });
      store.dispatch({ type: 'entry/confirmed', cid: 'e1', expenseId: 5, announcement: { text: 'Saved.' } });
    });
    expect(screen.getByRole('textbox', { name: 'Line' })).toHaveValue('');
    expect(store.getState().entries).toHaveLength(1);
    act(() => {
      store.dispatch({ type: 'line/set', line: 'chai 20' });
    });
    expect(screen.getByRole('textbox', { name: 'Line' })).toHaveValue('chai 20');
    expect(vi.getTimerCount()).toBe(baseline + 1);

    act(() => {
      notifyFinancialStateCleared();
    });
    expect(screen.getByRole('textbox', { name: 'Line' })).toHaveValue('');
    expect(screen.getByTestId('phases')).toHaveTextContent('');
    expect(store.getState().announcements).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('resets when the session is cleared through clearAuth', () => {
    const { store } = renderProbe();
    act(() => {
      store.dispatch({ type: 'line/set', line: '450 swiggy' });
      store.dispatch({ type: 'entry/submit', entry: newEntry('e1') });
    });
    expect(store.getState().entries).toHaveLength(1);
    act(() => {
      clearAuth();
    });
    expect(store.getState().entries).toHaveLength(0);
    expect(store.getState().line).toBe('');
  });

  it('stops its timers on unmount and keeps working under StrictMode', () => {
    const store = createQuickAddStore();
    const { unmount } = renderAuthenticated(
      <StrictMode>
        <FinancialClarityProvider>
          <MutationStatusProvider>
            <QuickAddProvider store={store}>
              <Probe />
            </QuickAddProvider>
          </MutationStatusProvider>
        </FinancialClarityProvider>
      </StrictMode>,
    );
    const baseline = vi.getTimerCount();
    act(() => {
      store.dispatch({ type: 'entry/submit', entry: newEntry('e1') });
    });
    // StrictMode mounted, unmounted, and mounted the provider again, and the timer still runs.
    expect(vi.getTimerCount()).toBe(baseline + 1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(store.getState().entries[0]?.wakingUp).toBe(true);

    act(() => {
      store.dispatch({ type: 'entry/failed', cid: 'e1', error: { message: 'x' } });
    });
    const settled = vi.getTimerCount();
    act(() => {
      store.dispatch({ type: 'entry/retry', cid: 'e1' });
    });
    expect(vi.getTimerCount()).toBe(settled + 1);
    unmount();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(settled);
  });

  it('throws a clear error when a hook is used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow('Quick Add hooks must be used inside QuickAddProvider');
    spy.mockRestore();
  });
});
