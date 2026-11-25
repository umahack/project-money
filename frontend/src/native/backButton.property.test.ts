import fc from 'fast-check';
import { describe, it } from 'vitest';
import { assertProperty } from '../test/propertyReport';
import { decideBackAction, type BackAction, type OverlayEntry } from './backButton';

const ACTIONS: readonly BackAction[] = ['close-overlay', 'consume', 'navigate-back', 'minimize'];

type OverlayState = 'absent' | 'closable' | 'locked';

/** Reference predicate from the design, checked in order. */
function reference(
  pathname: string,
  mustAgree: boolean,
  hasInAppHistory: boolean,
  overlay: OverlayState,
): BackAction {
  if (overlay === 'closable') return 'close-overlay';
  if (overlay === 'locked') return 'consume';
  if (pathname === '/agreement' && mustAgree) return 'minimize';
  if (pathname === '/' || pathname === '/login') return 'minimize';
  return hasInAppHistory ? 'navigate-back' : 'minimize';
}

const pathnames = fc.oneof(
  fc.constantFrom('/', '/login', '/agreement', '/settings', '/trips', '/trips/42', '/login/', '/agreement/', ''),
  fc.webPath().map((p) => `/${p}`),
  fc.string({ maxLength: 20 }),
);

const overlayStates = fc.constantFrom<OverlayState>('absent', 'closable', 'locked');

function entryFor(state: OverlayState): OverlayEntry | undefined {
  if (state === 'absent') return undefined;
  return { id: `overlay-${state}`, closable: state === 'closable', onClose: () => undefined };
}

describe('back-button decision properties', () => {
  // Feature: android-app-release, Property 3: The back-button decision is total and exact
  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
  it('returns exactly one action and always equals the reference predicate', () => {
    assertProperty(
      fc.property(pathnames, fc.boolean(), fc.boolean(), overlayStates, (pathname, mustAgree, hasInAppHistory, overlay) => {
        const action = decideBackAction({ pathname, mustAgree, hasInAppHistory, topOverlay: entryFor(overlay) });
        return ACTIONS.includes(action) && action === reference(pathname, mustAgree, hasInAppHistory, overlay);
      }),
    );
  });

  // Feature: android-app-release, Property 3: The back-button decision is total and exact
  it('lets an open overlay decide first: closable closes, locked consumes, whatever the route', () => {
    assertProperty(
      fc.property(pathnames, fc.boolean(), fc.boolean(), fc.boolean(), (pathname, mustAgree, hasInAppHistory, closable) => {
        const action = decideBackAction({
          pathname,
          mustAgree,
          hasInAppHistory,
          topOverlay: { id: 'o', closable, onClose: () => undefined },
        });
        return action === (closable ? 'close-overlay' : 'consume');
      }),
    );
  });

  // Feature: android-app-release, Property 3: The back-button decision is total and exact
  it('never navigates back on /agreement while the gate requires acknowledgement, and minimizes on root and login', () => {
    assertProperty(
      fc.property(fc.boolean(), (hasInAppHistory) => {
        const gated = decideBackAction({ pathname: '/agreement', mustAgree: true, hasInAppHistory, topOverlay: undefined });
        const root = decideBackAction({ pathname: '/', mustAgree: false, hasInAppHistory, topOverlay: undefined });
        const login = decideBackAction({ pathname: '/login', mustAgree: false, hasInAppHistory, topOverlay: undefined });
        return gated === 'minimize' && root === 'minimize' && login === 'minimize';
      }),
    );
  });

  // Feature: android-app-release, Property 3: The back-button decision is total and exact
  it('with no overlay on any other route, navigates back exactly when in-app history exists', () => {
    assertProperty(
      fc.property(
        pathnames.filter((p) => p !== '/' && p !== '/login' && p !== '/agreement'),
        fc.boolean(),
        fc.boolean(),
        (pathname, mustAgree, hasInAppHistory) => {
          const action = decideBackAction({ pathname, mustAgree, hasInAppHistory, topOverlay: undefined });
          return action === (hasInAppHistory ? 'navigate-back' : 'minimize');
        },
      ),
    );
  });
});
