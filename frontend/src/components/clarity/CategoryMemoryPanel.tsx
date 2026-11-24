import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  accessRoleLabel,
  categoryLabel,
  outcomeLabel,
  retentionLabel,
  sharingLabel,
} from '../../clarity/dataUseLabels';
import {
  memoryClient,
  type MemoryClient,
  type MemoryEntry,
  type MemoryResult,
  type MemoryStatus,
} from '../../clarity/quickAdd/memoryClient';
import { Card } from '../ui';
import './categoryMemory.css';

/** Requirement 6.7. Shown as plain text so nothing about the limit is hidden. */
const MEMORY_LIMIT = 500;
const ALL_KEY = 'settings:memory:all';
const rowKey = (id: number) => `settings:memory:${id}`;

const NOTICE_ACCESS_ROLES = ['account_user', 'authorized_administrators', 'service_operators_and_processors'];

type FocusTarget = { kind: 'heading' } | { kind: 'entry'; id: number };

/** Plain-language failure text. It never repeats server message text and never names a note. */
function failureText(status: MemoryStatus, what: string, was: 'was' | 'were'): string {
  if (status.status === 'unavailable') {
    return `Category memory is switched off on the server, so ${what} could not be changed.`;
  }
  if (status.status === 'conflict') {
    return `${what.charAt(0).toUpperCase()}${what.slice(1)} changed somewhere else. Reload the page to see the latest list, then try again.`;
  }
  if (status.retryable) {
    return `Could not confirm that ${what} ${was} forgotten. Check your connection, then retry.`;
  }
  return `Could not forget ${what}. Try again.`;
}

/**
 * Lists every remembered category choice with "Forget" for one and "Forget all" (Requirements 6.10, 6.11, 6.18, 14.7,
 * 16.1, 16.3). It exists only while Quick_Add_Enabled, so Settings is unchanged and no request is sent while it is off.
 *
 * The list shows the note as the server stores it (the simplified note key), because that is exactly what is kept.
 * Deleting an entry updates the cached hints in place, so the next category suggestion stops using it. Nothing here
 * writes a note, key, or category to the console or to browser storage.
 */
export function CategoryMemoryPanel({ client = memoryClient }: { client?: MemoryClient }) {
  if (!client.isEnabled()) return null;
  return <CategoryMemoryPanelBody client={client} />;
}

function CategoryMemoryPanelBody({ client }: { client: MemoryClient }) {
  const headingId = useId();
  const confirmId = useId();
  const query = useQuery(client.hintsQueryOptions(), client.cache);
  const clientState = useSyncExternalStore(client.subscribe, client.getState, client.getState);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const forgetButtons = useRef(new Map<number, HTMLButtonElement>());
  const forgetAllRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<FocusTarget | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const entries: readonly MemoryEntry[] = query.status === 'success' ? query.data.memory : EMPTY;
  const allStatus = clientState.statuses.get(ALL_KEY);

  // After a delete the control the user used is gone. Put focus on the next item, or on the heading, unless the user
  // already moved it somewhere else.
  useLayoutEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    const next = target.kind === 'entry' ? forgetButtons.current.get(target.id) : undefined;
    (next ?? headingRef.current)?.focus();
  }, [entries]);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  const finishOne = (entry: MemoryEntry, result: MemoryResult) => {
    if (result.status === 'saved') {
      client.discard(rowKey(entry.id));
      setAnnouncement(`Forgot the remembered choice for ${entry.noteKey}.`);
    } else {
      focusAfter.current = null;
    }
  };

  const forgetOne = async (entry: MemoryEntry, retry: boolean) => {
    const key = rowKey(entry.id);
    if (clientState.statuses.get(key)?.status === 'pending') return;
    const index = entries.findIndex((item) => item.id === entry.id);
    const neighbour = entries[index + 1] ?? entries[index - 1];
    focusAfter.current = neighbour ? { kind: 'entry', id: neighbour.id } : { kind: 'heading' };
    if (retry) forgetButtons.current.get(entry.id)?.focus();
    finishOne(entry, await (retry ? client.retry(key) : client.forget(key, { id: entry.id })));
  };

  const cancelConfirm = () => {
    setConfirming(false);
    forgetAllRef.current?.focus();
  };

  const forgetAll = async () => {
    if (allStatus?.status === 'pending') return;
    focusAfter.current = { kind: 'heading' };
    const retry = allStatus?.status === 'failed' && allStatus.retryable;
    const result = await (retry ? client.retry(ALL_KEY) : client.forgetAll(ALL_KEY));
    if (result.status === 'saved') {
      client.discard(ALL_KEY);
      setConfirming(false);
      setAnnouncement('Forgot all remembered choices.');
    } else {
      focusAfter.current = null;
    }
  };

  const outcome = outcomeLabel('category_suggestion');
  const allFailed = allStatus && (allStatus.status === 'failed' || allStatus.status === 'unavailable' || allStatus.status === 'conflict');
  const allPending = allStatus?.status === 'pending';
  const allRetry = allStatus?.status === 'failed' && allStatus.retryable;

  return (
    <Card className="memory-panel">
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        <span aria-hidden="true">🧠</span> {categoryLabel('category_memory')}
      </h2>
      <p className="muted small">
        When you pick a different category than the one Quick Add suggested, Project Money remembers your choice
        for that note, so the same note gets that category next time. You can see everything it remembers here and
        forget any of it.
      </p>
      <dl className="memory-facts small">
        <div>
          <dt>What is kept</dt>
          <dd>
            The note in a simplified form (lower case, extra spaces removed, at most 60 characters) and the
            category you chose. No amounts, dates, or links to your expenses.
          </dd>
        </div>
        <div>
          <dt>Used to</dt>
          <dd>
            Suggest a category for notes you have typed before. {outcome.label}: {outcome.definition}. It is used
            for nothing else.
          </dd>
        </div>
        <div>
          <dt>Where it is stored</dt>
          <dd>On the Project Money server, for your account only.</dd>
        </div>
        <div>
          <dt>Who can access it</dt>
          <dd>{NOTICE_ACCESS_ROLES.map(accessRoleLabel).join('; ')}.</dd>
        </div>
        <div>
          <dt>Sharing</dt>
          <dd>
            {sharingLabel('private')}. It is never part of public trip links or Product Analytics.
          </dd>
        </div>
        <div>
          <dt>How long</dt>
          <dd>{retentionLabel('until_account_deletion')}, or until you forget it here.</dd>
        </div>
        <div>
          <dt>Export and deletion</dt>
          <dd>
            Remembered choices are included when you download your account data, and are deleted with your
            account. Both are under Account controls on this page.
          </dd>
        </div>
      </dl>

      {query.status === 'pending' && <p className="muted small" aria-busy="true">Loading your remembered choices…</p>}

      {query.status === 'error' && (
        <p className="memory-notice small">
          Your remembered choices could not be loaded. Quick Add still saves your entries and suggests categories
          from your history, category names, and keywords. Reload the page to try again.
        </p>
      )}

      {query.status === 'success' && clientState.memoryUnavailable && (
        <p className="memory-notice small">
          Quick Add is not saving new remembered choices right now, and it does not use the ones below. You can
          still see them and forget them.
        </p>
      )}

      {query.status === 'success' && entries.length === 0 && (
        <p className="muted small">
          Nothing is remembered yet. When you pick a different category than the one Quick Add suggests, the
          choice appears here.
        </p>
      )}

      {query.status === 'success' && entries.length > 0 && (
        <>
          <p className="muted small">
            {entries.length === 1 ? '1 remembered choice' : `${entries.length} remembered choices`}, newest change
            first. Up to {MEMORY_LIMIT} are kept. Past that, the one changed longest ago is replaced.
          </p>
          <ul className="memory-list" aria-labelledby={headingId}>
            {entries.map((entry) => {
              const status = clientState.statuses.get(rowKey(entry.id));
              const pending = status?.status === 'pending';
              const failed = status && (status.status === 'failed' || status.status === 'unavailable' || status.status === 'conflict')
                ? status
                : null;
              return (
                <li key={entry.id} className="memory-row" aria-busy={pending || undefined}>
                  <p className="memory-row-text">
                    <strong>{entry.noteKey}</strong> goes in <strong>{entry.category}</strong>
                  </p>
                  <div className="memory-row-actions">
                    <button
                      type="button"
                      className="btn sm ghost danger"
                      ref={(element) => {
                        if (element) forgetButtons.current.set(entry.id, element);
                        else forgetButtons.current.delete(entry.id);
                      }}
                      aria-disabled={pending || undefined}
                      aria-label={`Forget the remembered choice for ${entry.noteKey}`}
                      onClick={() => { void forgetOne(entry, false); }}
                    >
                      Forget
                    </button>
                    {failed?.retryable && (
                      <button
                        type="button"
                        className="btn sm ghost"
                        aria-label={`Retry forgetting the remembered choice for ${entry.noteKey}`}
                        onClick={() => { void forgetOne(entry, true); }}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                  {pending && <p className="memory-row-status small">Forgetting…</p>}
                  {failed && (
                    <p role="alert" className="memory-row-failure small">
                      <strong>Not forgotten.</strong> {failureText(failed, 'this choice', 'was')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="memory-toolbar">
            <button
              type="button"
              className="btn ghost danger"
              ref={forgetAllRef}
              aria-expanded={confirming}
              aria-controls={confirming ? confirmId : undefined}
              onClick={() => setConfirming(true)}
            >
              Forget all
            </button>
          </div>

          {confirming && (
            <div
              id={confirmId}
              role="group"
              aria-labelledby={`${confirmId}-title`}
              className="memory-confirm"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !allPending) {
                  event.stopPropagation();
                  cancelConfirm();
                }
              }}
            >
              <p id={`${confirmId}-title`}><strong>Forget all {entries.length === 1 ? '1 remembered choice' : `${entries.length} remembered choices`}?</strong></p>
              <p className="small">
                Quick Add will suggest categories only from your history, category names, and keywords. Your saved
                expenses and their categories are not changed.
              </p>
              {allPending && <p className="memory-row-status small">Forgetting…</p>}
              {allFailed && (
                <p role="alert" className="memory-row-failure small">
                  <strong>Not forgotten.</strong> {failureText(allStatus, 'your remembered choices', 'were')}
                </p>
              )}
              <div className="memory-confirm-actions">
                <button
                  type="button"
                  className="btn danger-solid"
                  aria-disabled={allPending || undefined}
                  onClick={() => { void forgetAll(); }}
                >
                  {allRetry ? 'Retry' : 'Yes, forget all'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  ref={keepRef}
                  aria-disabled={allPending || undefined}
                  onClick={() => { if (!allPending) cancelConfirm(); }}
                >
                  Keep them
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    </Card>
  );
}

const EMPTY: readonly MemoryEntry[] = Object.freeze([]);
