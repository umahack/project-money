import type { ActionableInsight } from './contracts';

/**
 * Fixed registry of the routes, query keys, and hash anchors an action may use
 * to send the user back to an existing form (Requirements 1.3 to 1.7, 9.8).
 *
 * The URL carries only three kinds of context: a fixed action slug, a small set
 * of enum or numeric-ID parameters, and a fixed hash anchor. It never carries
 * an amount, a name, a note, an email address, or a trip name. Anything outside
 * the registry is ignored by the parser and cannot be produced by the builder.
 */

/** Action keys the backend may attach to an `ActionableInsight`. Matches `ACTION_KEYS` in measurementService.js. */
export const CLARITY_ACTION_KEYS = [
  'review_bills',
  'address_needs_budget_excess',
  'address_wants_budget_excess',
  'revise_goal_target',
  'contribute_to_goal',
  'settle_trip_balance',
] as const;
export type ClarityActionKey = (typeof CLARITY_ACTION_KEYS)[number];

export type ActionPage = 'home' | 'plan' | 'spending' | 'goals' | 'trips' | 'trip-detail';

export const TRIP_DETAIL_TABS = ['expenses', 'balances', 'people', 'share'] as const;
export type TripDetailTab = (typeof TRIP_DETAIL_TABS)[number];

export const BUDGET_BUCKETS = ['needs', 'wants'] as const;
export type BudgetBucket = (typeof BUDGET_BUCKETS)[number];

/** DOM IDs that existing forms and regions expose as arrival targets. */
export const ACTION_ANCHORS = [
  'home-pay-form',
  'pay-form',
  'bills-form',
  'expense-form',
  'category-budgets',
  'goals-list',
  'goal-form',
  'new-trip-form',
  'trip-expense-form',
  'trip-people-form',
  'trip-balances',
] as const;
export type ActionAnchor = (typeof ACTION_ANCHORS)[number];

/** Hash anchors a page accepts directly (for example `/plan#bills-form`). */
const PAGE_HASH_ANCHORS: Record<ActionPage, readonly ActionAnchor[]> = {
  home: [],
  plan: ['pay-form', 'bills-form'],
  spending: [],
  goals: [],
  trips: [],
  'trip-detail': [],
};

type ParamName = 'tab' | 'bucket' | 'goalId' | 'expenseId';
/** Canonical order of query keys in a built route. */
const PARAM_ORDER: readonly string[] = ['tab', 'action', 'bucket', 'goalId', 'expenseId'];

export interface ActionParams {
  tab?: TripDetailTab;
  bucket?: BudgetBucket;
  goalId?: number;
  expenseId?: number;
}

const ID_PATTERN = /^[1-9][0-9]{0,8}$/;

function parseId(raw: string): number | null {
  return ID_PATTERN.test(raw) ? Number(raw) : null;
}

const PARAM_PARSERS: { [K in ParamName]: (raw: string) => ActionParams[K] | null } = {
  tab: (raw) => (TRIP_DETAIL_TABS as readonly string[]).includes(raw) ? (raw as TripDetailTab) : null,
  bucket: (raw) => (BUDGET_BUCKETS as readonly string[]).includes(raw) ? (raw as BudgetBucket) : null,
  goalId: parseId,
  expenseId: parseId,
};

interface ActionDefinition {
  /** Parameters this action may carry. */
  params: readonly ParamName[];
  /** Tab that must be open for the form to exist (trip detail only). */
  tab?: TripDetailTab;
  /** DOM IDs to focus, most specific first. */
  targets(params: ActionParams): readonly string[];
}

const ACTIONS: Record<ActionPage, Readonly<Record<string, ActionDefinition>>> = {
  home: {
    'set-pay': { params: [], targets: () => ['home-pay-form'] },
  },
  plan: {},
  spending: {
    'log-expense': { params: [], targets: () => ['expense-form'] },
    'correct-expense': {
      params: ['expenseId'],
      targets: (p) => [...(p.expenseId ? [`expense-${p.expenseId}`] : []), 'expense-form'],
    },
    'review-budget': { params: ['bucket'], targets: () => ['category-budgets', 'expense-form'] },
  },
  goals: {
    'add-goal': { params: [], targets: () => ['goal-form'] },
    contribute: {
      params: ['goalId'],
      targets: (p) => [...(p.goalId ? [`goal-${p.goalId}`] : []), 'goals-list', 'goal-form'],
    },
    revise: {
      params: ['goalId'],
      targets: (p) => [...(p.goalId ? [`goal-${p.goalId}`] : []), 'goals-list', 'goal-form'],
    },
  },
  trips: {
    'new-trip': { params: [], targets: () => ['new-trip-form'] },
  },
  'trip-detail': {
    'add-expense': { params: ['tab'], tab: 'expenses', targets: () => ['trip-expense-form'] },
    'add-member': { params: ['tab'], tab: 'people', targets: () => ['trip-people-form'] },
    settle: { params: ['tab'], tab: 'balances', targets: () => ['trip-balances'] },
  },
};

const EXTRA_PAGE_PARAMS: Record<ActionPage, readonly ParamName[]> = {
  home: [],
  plan: [],
  spending: [],
  goals: [],
  trips: [],
  'trip-detail': ['tab'],
};

export type ActionSlug = string;

export function actionSlugsFor(page: ActionPage): readonly ActionSlug[] {
  return Object.keys(ACTIONS[page]);
}

export interface ActionContext {
  page: ActionPage;
  /** Fixed action slug from the registry, or null when absent or unknown. */
  action: ActionSlug | null;
  /** Validated hash anchor, or null. */
  anchor: ActionAnchor | null;
  /** Validated, allowlisted parameters only. */
  params: Readonly<ActionParams>;
  /** DOM IDs to scroll to and focus, most specific first. */
  targets: readonly string[];
}

export function emptyActionContext(page: ActionPage): ActionContext {
  return Object.freeze({ page, action: null, anchor: null, params: Object.freeze({}), targets: Object.freeze([]) });
}

function ownDefinition(page: ActionPage, slug: string | null): ActionDefinition | null {
  if (!slug || !Object.prototype.hasOwnProperty.call(ACTIONS[page], slug)) return null;
  return ACTIONS[page][slug] ?? null;
}

/**
 * Reads the action context from a location. Unknown actions, unknown query
 * keys, unknown anchors, and parameter values outside their fixed shape are
 * dropped. Nothing here can return free text from the URL.
 */
export function parseActionContext(page: ActionPage, search: string, hash: string): ActionContext {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return emptyActionContext(page);
  }
  const slug = query.get('action');
  const definition = ownDefinition(page, slug);
  const allowed = new Set<ParamName>([...(definition?.params ?? []), ...EXTRA_PAGE_PARAMS[page]]);

  const params: ActionParams = {};
  for (const name of allowed) {
    const raw = query.get(name);
    if (raw === null) continue;
    const value = PARAM_PARSERS[name](raw);
    if (value !== null) (params as Record<string, unknown>)[name] = value;
  }

  const hashValue = hash.startsWith('#') ? hash.slice(1) : hash;
  const anchor = (PAGE_HASH_ANCHORS[page] as readonly string[]).includes(hashValue)
    ? (hashValue as ActionAnchor)
    : null;

  const targets = [...(definition ? definition.targets(params) : []), ...(anchor ? [anchor] : [])];
  return Object.freeze({
    page,
    action: definition ? slug : null,
    anchor,
    params: Object.freeze(params),
    targets: Object.freeze(targets),
  });
}

export interface ActionRouteSpec {
  page: ActionPage;
  action?: ActionSlug;
  anchor?: ActionAnchor;
  params?: ActionParams;
  /** Required for `trip-detail`. */
  tripId?: number;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && ID_PATTERN.test(String(value));
}

/**
 * Builds an in-app route from fixed parts. Returns null when the page, action,
 * anchor, or a parameter is outside the registry, so callers never fall back to
 * an unvalidated string.
 */
export function buildActionRoute(spec: ActionRouteSpec): string | null {
  const { page } = spec;
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, page)) return null;
  const definition = spec.action === undefined ? null : ownDefinition(page, spec.action);
  if (spec.action !== undefined && !definition) return null;
  if (spec.anchor !== undefined && !(PAGE_HASH_ANCHORS[page] as readonly string[]).includes(spec.anchor)) return null;

  let pathname: string;
  switch (page) {
    case 'home': pathname = '/'; break;
    case 'plan': pathname = '/plan'; break;
    case 'spending': pathname = '/spending'; break;
    case 'goals': pathname = '/goals'; break;
    case 'trips': pathname = '/trips'; break;
    case 'trip-detail':
      if (!isPositiveId(spec.tripId)) return null;
      pathname = `/trips/${spec.tripId}`;
      break;
  }

  const supplied = spec.params ?? {};
  const allowed = new Set<ParamName>([...(definition?.params ?? []), ...EXTRA_PAGE_PARAMS[page]]);
  const pairs = new Map<string, string>();
  for (const name of Object.keys(supplied)) {
    if (!allowed.has(name as ParamName)) return null;
    const value = supplied[name as ParamName];
    if (value === undefined) continue;
    if (PARAM_PARSERS[name as ParamName](String(value)) === null) return null;
    pairs.set(name, String(value));
  }
  if (definition?.tab && !pairs.has('tab')) pairs.set('tab', definition.tab);
  if (spec.action !== undefined) pairs.set('action', spec.action);

  const query = PARAM_ORDER.filter((key) => pairs.has(key))
    .map((key) => `${key}=${encodeURIComponent(pairs.get(key)!)}`)
    .join('&');
  return `${pathname}${query ? `?${query}` : ''}${spec.anchor ? `#${spec.anchor}` : ''}`;
}

/** Tab to open for an action on the trip detail page, or null when the action has none. */
export function tabForAction(action: string | null): TripDetailTab | null {
  return ownDefinition('trip-detail', action)?.tab ?? null;
}

interface InsightRecordContext {
  recordType?: string;
  recordId?: number;
}

function recordId(context: InsightRecordContext | undefined, type: string): number | undefined {
  return context?.recordType === type && isPositiveId(context.recordId) ? context.recordId : undefined;
}

const ACTION_KEY_ROUTES: Record<ClarityActionKey, (context?: InsightRecordContext) => string | null> = {
  review_bills: () => buildActionRoute({ page: 'plan', anchor: 'bills-form' }),
  address_needs_budget_excess: () =>
    buildActionRoute({ page: 'spending', action: 'review-budget', params: { bucket: 'needs' } }),
  address_wants_budget_excess: () =>
    buildActionRoute({ page: 'spending', action: 'review-budget', params: { bucket: 'wants' } }),
  revise_goal_target: (c) => {
    const goalId = recordId(c, 'goal');
    return buildActionRoute({ page: 'goals', action: 'revise', params: goalId ? { goalId } : {} });
  },
  contribute_to_goal: (c) => {
    const goalId = recordId(c, 'goal');
    return buildActionRoute({ page: 'goals', action: 'contribute', params: goalId ? { goalId } : {} });
  },
  settle_trip_balance: (c) => {
    const tripId = recordId(c, 'trip');
    return tripId ? buildActionRoute({ page: 'trip-detail', action: 'settle', tripId }) : null;
  },
};

const ACTION_KEY_PAGE: Record<ClarityActionKey, ActionPage> = {
  review_bills: 'plan',
  address_needs_budget_excess: 'spending',
  address_wants_budget_excess: 'spending',
  revise_goal_target: 'goals',
  contribute_to_goal: 'goals',
  settle_trip_balance: 'trip-detail',
};

export function isClarityActionKey(value: unknown): value is ClarityActionKey {
  return typeof value === 'string' && (CLARITY_ACTION_KEYS as readonly string[]).includes(value);
}

/**
 * Returns the insight with a route rebuilt from its fixed action key and
 * record ID, or null when the key is unknown or the required record is missing.
 * The server-provided route string is never used to choose where the browser goes.
 */
export function resolveInsightAction(insight: ActionableInsight): ActionableInsight | null {
  if (!isClarityActionKey(insight.actionKey)) return null;
  const route = ACTION_KEY_ROUTES[insight.actionKey](insight.context);
  return route ? { ...insight, route } : null;
}

/** Pages on which an insight with this key is the relevant action. */
export function actionKeyPage(key: ClarityActionKey): ActionPage {
  return ACTION_KEY_PAGE[key];
}

/**
 * First insight, in the server's ranked order, that is valid and relevant to the page.
 * Home accepts any valid insight. Trip detail accepts only the open trip's insight.
 */
export function pickPageAction(
  actions: readonly ActionableInsight[] | undefined,
  page: ActionPage,
  options: { tripId?: number } = {},
): ActionableInsight | null {
  for (const insight of actions ?? []) {
    if (!isClarityActionKey(insight.actionKey)) continue;
    const keyPage = ACTION_KEY_PAGE[insight.actionKey];
    if (page === 'trips' ? keyPage !== 'trip-detail' : page !== 'home' && keyPage !== page) continue;
    if (page === 'trip-detail' && recordId(insight.context, 'trip') !== options.tripId) continue;
    const resolved = resolveInsightAction(insight);
    if (resolved) return resolved;
  }
  return null;
}

/** The decision each page answers, in the words of Requirements 1.3 to 1.7. */
export const PAGE_DECISIONS: Readonly<Record<ActionPage, string>> = Object.freeze({
  home: 'Which current financial condition needs attention?',
  plan: 'How much income is available to spend and save?',
  spending: 'Does current spending fit the monthly plan?',
  goals: 'What contribution is required for the selected goal?',
  trips: 'Do you owe, are you owed, or are you settled?',
  'trip-detail': 'Do you owe, are you owed, or are you settled on this trip?',
});

export interface FallbackAction {
  label: string;
  to: string;
}

function fallback(label: string, spec: ActionRouteSpec): FallbackAction {
  const to = buildActionRoute(spec);
  if (!to) throw new Error(`Fallback action "${label}" is outside the action registry`);
  return { label, to };
}

/** Fixed fallback actions, used when no ranked insight applies to the page. */
export const FALLBACK_ACTIONS = Object.freeze({
  homeSetPay: fallback('Enter this month’s pay', { page: 'home', action: 'set-pay' }),
  homeAddBills: fallback('Add your monthly bills', { page: 'plan', anchor: 'bills-form' }),
  homeLogSpending: fallback('Log today’s spending', { page: 'spending', action: 'log-expense' }),
  planSetPay: fallback('Add this month’s pay', { page: 'plan', anchor: 'pay-form' }),
  planAddBills: fallback('Add your monthly bills', { page: 'plan', anchor: 'bills-form' }),
  planCorrect: fallback('Correct pay or bills', { page: 'plan', anchor: 'pay-form' }),
  spendingRecord: fallback('Record or correct an expense', { page: 'spending', action: 'log-expense' }),
  goalsContribute: fallback('Record a contribution or adjust a goal', { page: 'goals', action: 'contribute' }),
  tripsNew: fallback('Create your first trip', { page: 'trips', action: 'new-trip' }),
});

export function tripBalancesFallback(tripId: number): FallbackAction | null {
  const to = buildActionRoute({ page: 'trip-detail', params: { tab: 'balances' }, tripId });
  return to ? { label: 'Review trip balances', to } : null;
}

export function tripDetailFallback(
  kind: 'settle' | 'add-member' | 'add-expense',
  tripId: number,
): FallbackAction | null {
  const to = buildActionRoute({ page: 'trip-detail', action: kind, tripId });
  if (!to) return null;
  const label = kind === 'settle' ? 'Record a settlement' : kind === 'add-member' ? 'Add the people on this trip' : 'Add a shared expense';
  return { label, to };
}
