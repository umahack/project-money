import { useEffect, useRef, useState } from 'react';
import { formatInr } from '../../clarity/quickAdd/amount';
import { useQuickAddStore } from '../../clarity/quickAdd/QuickAddProvider';
import {
  UNDO_WINDOW_MS,
  isUndoPaused,
  undoRemainingMs,
  type QuickAddEntry,
} from '../../clarity/quickAdd/quickAddStore';
import './quickAdd.css';
import './quickAddEntries.css';

/** Requirement 8.1: static text, shown whether or not the countdown or the bar is. */
export const UNDO_AVAILABLE_TEXT = 'Undo is available for 8 seconds.';
export const UNDO_LABEL = 'Undo';
export const UNDO_REMOVING_TEXT = 'Removing this entry…';
export const UNDO_RETRY_LABEL = 'Retry undo';
export const UNDO_STILL_SAVED_TEXT = 'The entry is still saved. You can try Undo again.';
/** How often the remaining-time text is re-read while the window is open and not paused. */
const TICK_MS = 250;

/** The name that identifies one entry to a screen reader: its amount and note (Requirement 8.14). */
export function entryLabel(entry: Pick<QuickAddEntry, 'parsed'>): string {
  const { amountMinor, note } = entry.parsed;
  return `${formatInr(amountMinor)}${note === '' ? '' : ` ${note}`}`;
}

export function remainingText(ms: number, paused: boolean): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const left = `${seconds} ${seconds === 1 ? 'second' : 'seconds'} left`;
  return paused ? `Paused while you use Undo. ${left}.` : `${left}.`;
}

/** Re-reads the clock while `active`, so the remaining-time text follows the store's deadline. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const handle = globalThis.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => globalThis.clearInterval(handle);
  }, [active]);
  return now;
}

export interface UndoControlProps {
  entry: QuickAddEntry;
  /** Starts the undo. For `undo_failed` it is the same-key retry. */
  onUndo(): void;
  /** Id of the element that names the entry, so the control can be described by it. */
  describedBy?: string;
}

/**
 * The Undo control of one entry: a button named by the entry's amount and note, the static text that Undo is available
 * for 8 seconds, the time left as text, and a thin bar that shrinks while motion is allowed.
 *
 * It pauses the store's Undo window while the pointer is over the button or the button has keyboard focus, and resumes
 * when both end (Requirement 8.10). It stays through an undo that is pending or has failed (Requirement 8.9). When the
 * window ends the store removes the control and the expense stays (Requirement 8.11).
 */
export function UndoControl({ entry, onUndo, describedBy }: UndoControlProps) {
  const store = useQuickAddStore();
  const { cid } = entry;
  const windowOpen = entry.phase === 'saved' && entry.undo !== undefined;
  const paused = isUndoPaused(entry);
  const now = useNow(windowOpen && !paused);
  const remaining = undoRemainingMs(entry, now);

  // Where the bar starts, so a control that mounts late (the toast) shows the time that is really left.
  const elapsedAtMount = useRef(remaining === null ? 0 : Math.max(0, UNDO_WINDOW_MS - remaining));

  const pause = (source: 'pointer' | 'focus') => {
    if (windowOpen) store.dispatch({ type: 'undo/pause', cid, source });
  };
  const resume = (source: 'pointer' | 'focus') => {
    store.dispatch({ type: 'undo/resume', cid, source });
  };

  const removing = entry.phase === 'removing';
  const failed = entry.phase === 'undo_failed';
  const name = `${failed ? UNDO_RETRY_LABEL : UNDO_LABEL} ${entryLabel(entry)}`;

  return (
    <div className="qa-undo" data-phase={entry.phase} data-paused={paused || undefined}>
      <button
        type="button"
        className="btn sm qa-undo-button"
        aria-label={name}
        aria-describedby={describedBy}
        aria-disabled={removing || undefined}
        onClick={() => {
          if (!removing) onUndo();
        }}
        onPointerEnter={() => pause('pointer')}
        onPointerLeave={() => resume('pointer')}
        onFocus={() => pause('focus')}
        onBlur={() => resume('focus')}
      >
        {removing ? 'Removing…' : failed ? UNDO_RETRY_LABEL : UNDO_LABEL}
      </button>
      {windowOpen && (
        <>
          <span className="qa-undo-text small">{UNDO_AVAILABLE_TEXT}</span>
          {remaining !== null && (
            <span className="qa-undo-left small" data-testid="undo-remaining">{remainingText(remaining, paused)}</span>
          )}
          {/* The bar repeats the text and is decorative. It is hidden entirely when reduced motion is requested. */}
          <span className="qa-undo-bar" aria-hidden="true">
            <span
              className="qa-undo-fill"
              style={{
                animationDuration: `${UNDO_WINDOW_MS}ms`,
                animationDelay: `-${Math.round(elapsedAtMount.current)}ms`,
                animationPlayState: paused ? 'paused' : 'running',
              }}
            />
          </span>
        </>
      )}
      {removing && <span className="qa-undo-text small">{UNDO_REMOVING_TEXT}</span>}
      {failed && <span className="qa-undo-text small">{UNDO_STILL_SAVED_TEXT}</span>}
    </div>
  );
}
