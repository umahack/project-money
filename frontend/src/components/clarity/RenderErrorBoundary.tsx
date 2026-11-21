import { Component, type ReactNode } from 'react';
import './clarity.css';

/** The only code this boundary ever shows. It carries no value, name, or URL. */
export const RENDER_FAILURE_CODE = 'RENDER_FAILED';

export type RenderBoundaryScope = 'region' | 'page' | 'app';

export interface RenderErrorBoundaryProps {
  /**
   * How much the boundary contains: one page region, the routed page inside
   * the app shell (navigation stays), or the whole app as a last resort.
   */
  scope: RenderBoundaryScope;
  /** Plain name used in the fixed message, for example "Monthly summary". */
  label: string;
  /** When any entry changes, a failed boundary clears itself (for example the route path). */
  resetKeys?: readonly unknown[];
  /** Called once when the user retries, before the children render again. */
  onRetry?: () => void;
  /** Called right before the retry re-renders, so the caller can arm focus recovery. */
  onBeforeRetry?: () => void;
  /** Element to focus after a retry when focus would otherwise fall to the page body. */
  focusAfterRetry?: () => HTMLElement | null;
  children: ReactNode;
}

interface RenderErrorBoundaryState {
  failed: boolean;
}

function sameKeys(left: readonly unknown[] = [], right: readonly unknown[] = []): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function failureCopy(scope: RenderBoundaryScope, label: string): { title: string; detail: string } {
  if (scope === 'region') {
    return {
      title: `${label} could not be displayed.`,
      detail: 'Your saved data is safe and your other sections are unaffected.',
    };
  }
  if (scope === 'page') {
    return {
      title: `${label} could not be displayed.`,
      detail: 'Your saved data is safe. Navigation still works, or you can try again.',
    };
  }
  return {
    title: 'Project Money could not display this screen.',
    detail: 'Your saved data is safe. Try again.',
  };
}

function refocus(target: HTMLElement | null | undefined): void {
  if (!target) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * Catches an unexpected render error below it and shows a fixed, value-free
 * message with one retry, so one failed region never blanks its page or the
 * navigation (Requirement 10.15 and the design's Failure Containment rules).
 *
 * It deliberately does not read, display, or report the error: an error message
 * or component stack can contain amounts, names, or URLs with record IDs. The
 * state above it (query cache, confirmed snapshots, mutation status) is not
 * touched, so confirmed values are still there when the region renders again.
 * Retry re-renders the children in place; it never reloads the document.
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: RenderErrorBoundaryProps): void {
    if (this.state.failed && !sameKeys(previous.resetKeys, this.props.resetKeys)) {
      this.setState({ failed: false });
    }
  }

  private retry = (): void => {
    const { onBeforeRetry, onRetry, focusAfterRetry } = this.props;
    onBeforeRetry?.();
    onRetry?.();
    this.setState({ failed: false }, () => refocus(focusAfterRetry?.()));
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    const { scope, label } = this.props;
    const { title, detail } = failureCopy(scope, label);
    return (
      <div
        className="clarity-region-error clarity-render-failure"
        role="alert"
        data-render-failure={scope}
        data-error-code={RENDER_FAILURE_CODE}
      >
        <p>
          <span aria-hidden="true" className="clarity-glyph">✕</span>
          <strong>{title}</strong> {detail}
        </p>
        <p className="muted tiny">Error code: {RENDER_FAILURE_CODE}</p>
        <button
          type="button"
          className="btn sm ghost clarity-retry"
          aria-label={scope === 'app' ? 'Try again' : `Retry showing ${label}`}
          onClick={this.retry}
        >
          Retry
        </button>
      </div>
    );
  }
}
