// The draft that the input, the preview, the warning, and the category choice share.
//
// `QuickAddDraftProvider` reads the draft line from the Quick Add store, parses it with the Kolkata date, suggests a
// category, classifies the Entry_Warning, and gives the four components one set of ids and one `submit`. It holds only
// what is not in the store: the category the User chose for the current note, whether a submit was attempted on an
// invalid line, and the status of a "Forget this" action. All of it is in memory only (Requirement 14.3).
//
// While Quick_Add_Enabled is off the provider renders its children and nothing else: no hook that reads the store, the
// hints, or the snapshot runs, and no request is sent (Requirement 16.2). The components then render nothing.
//
// Requirements: 3.1, 3.6 to 3.10, 3.12, 5.14, 5.15, 6.1, 6.2, 6.12, 7.1, 7.3, 18.1 to 18.7, 18.9.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { useKolkataToday } from '../../clarity/quickAdd/kolkata';
import {
  memoryClient,
  useQuickAddHints,
  useSuggestionSources,
  type MemoryClient,
  type QuickAddHintsView,
} from '../../clarity/quickAdd/memoryClient';
import { normalizeNoteKey } from '../../clarity/quickAdd/noteKey';
import { parseQuickAddLine, type ParsedEntry, type ParseProblem, type ParseResult } from '../../clarity/quickAdd/parser';
import { useQuickAddLine, useSubmissionBlockedReason } from '../../clarity/quickAdd/QuickAddProvider';
import { suggestCategory, type CategorySuggestion } from '../../clarity/quickAdd/suggester';
import { useQuickAddActions, type QuickAddActions } from '../../clarity/quickAdd/useQuickAddActions';
import { classifyEntryWarning, type EntryWarning } from '../../clarity/quickAdd/warning';
import { selectQuickAddEnabled } from '../../clarity/rollout';
import { focusQuickAddInput } from './inputFocus';
import { useQuickAddContext } from './useQuickAddContext';

export type ActiveEntryWarning = Extract<EntryWarning, { kind: 'warn' }>;

export type ForgetStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

export const FORGET_DONE_TEXT = 'Forgotten. Quick Add now suggests from your history, category names, and keywords.';
export const FORGET_FAILED_TEXT = 'The remembered choice could not be removed. It is still in use. Try Forget this again.';
export const FORGET_UNAVAILABLE_TEXT = 'Remembered choices are unavailable right now, so nothing was changed.';
export const GATE_PAUSED_TEXT = 'Your data-use settings need attention before new entries can be added.';

export interface QuickAddDraftIds {
  input: string;
  help: string;
  preview: string;
  warning: string;
  category: string;
  reason: string;
  paused: string;
  blocked: string;
  limit: string;
  forget: string;
}

export interface SubmitOptions {
  /** "Save, but don't count against today". Honored only for an entry dated Today. */
  excludeFromToday?: boolean;
}

export interface QuickAddDraftValue {
  ids: QuickAddDraftIds;
  line: string;
  setLine(line: string): void;
  /** The Kolkata date the line is read against. */
  today: string;
  /** Null while the line is blank, because there is nothing to preview (Requirement 3.12). */
  parse: ParseResult | null;
  entry: ParsedEntry | null;
  problems: readonly ParseProblem[];
  /**
   * How many times a submit on this exact line found problems (Requirements 3.8, 3.9). Zero when none, and again
   * zero as soon as the line changes. A repeated Enter raises it, so the problems are announced again.
   */
  attemptCount: number;
  suggestion: CategorySuggestion | null;
  /** The category that will be saved: the User's choice, or the suggestion. */
  category: string | null;
  categories: readonly string[];
  chooseCategory(category: string): void;
  noteKey: string | null;
  warning: ActiveEntryWarning | null;
  hints: QuickAddHintsView;
  /** True while the Data_Use_Gate pauses new financial inputs (Requirement 1.13). */
  gated: boolean;
  gateReason: string | null;
  /** The text that says earlier entries are still saving, or null (Requirement 7.12). */
  blockedReason: string | null;
  /** True when pressing Enter or Save would send a request or show the problems. */
  canSubmit: boolean;
  submit(options?: SubmitOptions): void;
  forgetStatus: ForgetStatus;
  forget(): void;
  /**
   * The one set of Quick Add actions of this provider (retry, edit, discard, undo, category and exclusion changes,
   * recalculate). The status rows, the answer, and the Undo toast use it, so they share the memory client and the
   * data context that the input uses.
   */
  actions: QuickAddActions;
}

const QuickAddDraftContext = createContext<QuickAddDraftValue | null>(null);

/** The shared draft, or null while Quick_Add_Enabled is off. */
export function useQuickAddDraft(): QuickAddDraftValue | null {
  return useContext(QuickAddDraftContext);
}

/** For a component that renders only while enabled: the draft, or a clear error when no provider is mounted. */
export function useRequiredQuickAddDraft(): QuickAddDraftValue | null {
  const draft = useContext(QuickAddDraftContext);
  if (!selectQuickAddEnabled()) return null;
  if (!draft) throw new Error('Quick Add components must be used inside QuickAddDraftProvider');
  return draft;
}

export interface QuickAddDraftProviderProps {
  children: ReactNode;
  /** The memory client. Defaults to the application client. Tests pass an isolated one. */
  memory?: MemoryClient;
}

export function QuickAddDraftProvider({ children, memory = memoryClient }: QuickAddDraftProviderProps) {
  if (!selectQuickAddEnabled()) return <>{children}</>;
  return <EnabledDraftProvider memory={memory}>{children}</EnabledDraftProvider>;
}

interface Choice {
  note: string;
  category: string;
}

function EnabledDraftProvider({ children, memory }: { children: ReactNode; memory: MemoryClient }) {
  const base = useId();
  const ids = useMemo<QuickAddDraftIds>(() => ({
    input: `${base}-input`,
    help: `${base}-help`,
    preview: `${base}-preview`,
    warning: `${base}-warning`,
    category: `${base}-category`,
    reason: `${base}-reason`,
    paused: `${base}-paused`,
    blocked: `${base}-blocked`,
    limit: `${base}-limit`,
    forget: `${base}-forget`,
  }), [base]);

  const [line, setLine] = useQuickAddLine();
  const today = useKolkataToday();
  const context = useQuickAddContext();
  const hints = useQuickAddHints(memory);
  const sources = useSuggestionSources(memory);
  const gate = useDataUseGate();
  const blockedReason = useSubmissionBlockedReason();
  const actions = useQuickAddActions({ ...context, memory });

  const [choice, setChoice] = useState<Choice | null>(null);
  const [attempt, setAttempt] = useState<{ line: string; count: number } | null>(null);
  const [forgetStatus, setForgetStatus] = useState<ForgetStatus>({ kind: 'idle' });
  const [focusCategory, setFocusCategory] = useState(false);

  // Synchronous: the preview is derived in the same render as the keystroke (Requirement 3.1).
  const parse = useMemo<ParseResult | null>(() => (line.trim() === '' ? null : parseQuickAddLine(line, today)), [line, today]);
  const entry = parse?.ok ? parse.entry : null;
  const problems = useMemo<readonly ParseProblem[]>(() => (parse && !parse.ok ? parse.problems : []), [parse]);

  const noteKey = useMemo(() => (entry ? normalizeNoteKey(entry.note) : null), [entry]);
  const suggestion = useMemo<CategorySuggestion | null>(() => (
    entry
      ? suggestCategory({ note: entry.note, categories: context.categories, memory: sources.memory, history: sources.history })
      : null
  ), [entry, context.categories, sources]);

  const category = useMemo(() => {
    if (!entry || !suggestion) return null;
    if (choice && choice.note === entry.note && context.categories.includes(choice.category)) return choice.category;
    return suggestion.category;
  }, [entry, suggestion, choice, context.categories]);

  const warning = useMemo<ActiveEntryWarning | null>(() => {
    if (!entry) return null;
    const result = classifyEntryWarning({
      entry,
      today,
      billKeys: context.billLabels,
      largeEntryThresholdMinor: context.largeEntryThresholdMinor,
    });
    return result.kind === 'warn' ? result : null;
  }, [entry, today, context.billLabels, context.largeEntryThresholdMinor]);

  const gated = !gate.financialInputsEnabled;
  const gateReason = gated ? (gate.reason ?? GATE_PAUSED_TEXT) : null;
  const canSubmit = line.trim() !== '' && !gated && blockedReason === null;

  const chooseCategory = useCallback((next: string) => {
    if (!entry || !suggestion) return;
    // Choosing the suggestion again is the same as no choice.
    setChoice(next === suggestion.category ? null : { note: entry.note, category: next });
  }, [entry, suggestion]);

  const submit = useCallback((options: SubmitOptions = {}) => {
    if (!canSubmit) return;
    if (!parse || !parse.ok) {
      // Requirement 3.7: no request. Requirements 3.8 to 3.10: the problems are shown as text, the line is untouched.
      setAttempt((previous) => ({ line, count: (previous?.line === line ? previous.count : 0) + 1 }));
      return;
    }
    // The line, the category, and the mark are what the User saw. The row is added and the input cleared by the store
    // in the same step (Requirements 7.2, 7.3).
    void actions.submit({
      line,
      ...(category ? { category } : {}),
      ...(options.excludeFromToday ? { excludeFromToday: true } : {}),
    }).catch(() => undefined);
    setChoice(null);
    setAttempt(null);
    setForgetStatus({ kind: 'idle' });
    // A button that held focus (a warning choice) disappears with the line, so focus goes back first.
    focusQuickAddInput();
  }, [actions, canSubmit, category, line, parse]);

  const forgetBusy = useRef(false);
  const forget = useCallback(() => {
    if (!noteKey || forgetBusy.current) return;
    forgetBusy.current = true;
    setForgetStatus({ kind: 'pending' });
    void (async () => {
      try {
        const result = await actions.forgetMemory({ noteKey });
        if (result.status === 'saved' || result.status === 'not_found') {
          setForgetStatus({ kind: 'done' });
          setChoice(null);
          setFocusCategory(true);
        } else if (result.status === 'unavailable') {
          setForgetStatus({ kind: 'failed', message: FORGET_UNAVAILABLE_TEXT });
        } else if (result.status === 'disabled') {
          setForgetStatus({ kind: 'idle' });
        } else {
          setForgetStatus({ kind: 'failed', message: FORGET_FAILED_TEXT });
        }
      } catch {
        setForgetStatus({ kind: 'failed', message: FORGET_FAILED_TEXT });
      } finally {
        forgetBusy.current = false;
      }
    })();
  }, [actions, noteKey]);

  // The Forget button leaves when the suggestion no longer comes from memory, so focus moves to the category control.
  useEffect(() => {
    if (!focusCategory) return;
    document.getElementById(ids.category)?.focus();
    setFocusCategory(false);
  }, [focusCategory, ids.category]);

  // A status about one note is not carried to the next note.
  const noteForStatus = entry?.note ?? null;
  useEffect(() => {
    setForgetStatus((current) => (current.kind === 'idle' ? current : { kind: 'idle' }));
  }, [noteForStatus]);

  const value = useMemo<QuickAddDraftValue>(() => ({
    ids,
    line,
    setLine,
    today,
    parse,
    entry,
    problems,
    attemptCount: attempt !== null && attempt.line === line && problems.length > 0 ? attempt.count : 0,
    suggestion,
    category,
    categories: context.categories,
    chooseCategory,
    noteKey,
    warning,
    hints,
    gated,
    gateReason,
    blockedReason,
    canSubmit,
    submit,
    forgetStatus,
    forget,
    actions,
  }), [
    ids, line, setLine, today, parse, entry, problems, attempt, suggestion, category, context.categories,
    chooseCategory, noteKey, warning, hints, gated, gateReason, blockedReason, canSubmit, submit, forgetStatus, forget,
    actions,
  ]);

  return <QuickAddDraftContext.Provider value={value}>{children}</QuickAddDraftContext.Provider>;
}
