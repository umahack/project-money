import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useQuickAddSelector, useQuickAddStore } from '../../clarity/quickAdd/QuickAddProvider';
import type { QuickAddAnnouncement, QuickAddState } from '../../clarity/quickAdd/quickAddStore';
import {
  CHANGE_FAILED_TEXT,
  SAVE_FAILED_TEXT,
  UNDO_FAILED_TEXT,
} from '../../clarity/quickAdd/useQuickAddActions';
import { selectQuickAddEnabled } from '../../clarity/rollout';

/** Messages the actions queue as plain announcements that are errors. They are spoken assertively. */
const ERROR_TEXTS: ReadonlySet<string> = new Set([SAVE_FAILED_TEXT, UNDO_FAILED_TEXT, CHANGE_FAILED_TEXT]);

export function isErrorAnnouncement(announcement: Pick<QuickAddAnnouncement, 'assertive' | 'text'>): boolean {
  return announcement.assertive || ERROR_TEXTS.has(announcement.text);
}

interface Spoken {
  /** Changes with every message, so the same sentence spoken twice is a new node and is read twice. */
  key: string;
  text: string;
}

/** One sentence each, in order, without repeating a sentence inside one batch. */
function combine(items: readonly QuickAddAnnouncement[]): Spoken | null {
  const texts = [...new Set(items.map((item) => item.text))];
  const last = items[items.length - 1];
  return last && texts.length > 0 ? { key: last.key, text: texts.join(' ') } : null;
}

/* Only one Announcer may speak. A second one mounted elsewhere (the inline panel and the dialog) stays silent, so a
   message is never spoken twice. When the speaking one unmounts the next one takes over. */
const owners: string[] = [];
const ownerListeners = new Set<() => void>();

function subscribeOwners(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

function ownerSnapshot(): string {
  return owners[0] ?? '';
}

function claim(id: string): () => void {
  owners.push(id);
  for (const listener of [...ownerListeners]) listener();
  return () => {
    const index = owners.indexOf(id);
    if (index >= 0) owners.splice(index, 1);
    for (const listener of [...ownerListeners]) listener();
  };
}

function selectAnnouncements(state: QuickAddState): readonly QuickAddAnnouncement[] {
  return state.announcements;
}

/**
 * Speaks the store's announcements through ONE polite live region, and through one assertive region only for errors
 * (Requirements 12.3, 9.18, 8.8). Each message is spoken once: it is taken out of the store's queue (`announcement/consume`)
 * as soon as it is shown. Messages queued together are spoken as one sentence group, and a sentence repeated inside the
 * group is spoken once. A pending state is never queued by the actions, so it is never announced.
 *
 * It renders both regions empty from the start, because a live region speaks only what changes after it exists.
 * Renders nothing while Quick_Add_Enabled is off. Mount it once, for example in the Shell; a second instance stays silent.
 */
export function Announcer() {
  if (!selectQuickAddEnabled()) return null;
  return <EnabledAnnouncer />;
}

function EnabledAnnouncer() {
  const store = useQuickAddStore();
  const id = useId();
  const queue = useQuickAddSelector(selectAnnouncements);
  const owner = useSyncExternalStore(subscribeOwners, ownerSnapshot, () => '');
  const [polite, setPolite] = useState<Spoken | null>(null);
  const [assertive, setAssertive] = useState<Spoken | null>(null);
  const seen = useRef(new Set<string>());

  useEffect(() => claim(id), [id]);

  const speaking = owner === id;

  useEffect(() => {
    if (!speaking || queue.length === 0) return;
    const fresh = queue.filter((item) => !seen.current.has(item.key));
    if (fresh.length === 0) return;
    for (const item of fresh) seen.current.add(item.key);
    const calm = combine(fresh.filter((item) => !isErrorAnnouncement(item)));
    const errors = combine(fresh.filter((item) => isErrorAnnouncement(item)));
    if (calm) setPolite(calm);
    if (errors) setAssertive(errors);
    // The message is in the region now, so it leaves the queue and cannot be spoken again.
    for (const item of fresh) store.dispatch({ type: 'announcement/consume', key: item.key });
  }, [queue, speaking, store]);

  if (!speaking) return null;
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="quick-add-polite">
        {polite && <span key={polite.key}>{polite.text}</span>}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only" data-testid="quick-add-assertive">
        {assertive && <span key={assertive.key}>{assertive.text}</span>}
      </div>
    </>
  );
}
