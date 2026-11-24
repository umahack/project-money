// Layout audit used by the responsive acceptance specs (task 17.3).
//
// One in-page pass reports, for the document as rendered with the real, unmodified CSS:
//
// - page overflow: the document is wider than the viewport, or any element sticks out past
//   the left or right edge,
// - region overflow and clipping: an element scrolls or clips its own content horizontally
//   (`scrollWidth > clientWidth`), a descendant sticks out of an ancestor that clips it, or
//   text is truncated with an ellipsis,
// - overlap: two visible text blocks or controls on the same layer intersect and neither
//   contains the other,
// - touch targets: an interactive control is smaller than 44 by 44 CSS pixels (opt in),
// - measure: main content, the top bar, or a paragraph is wider than a readable limit (opt in).
//
// It returns plain strings so a failing assertion prints every defect with its selector.
import type { Page } from '@playwright/test';

export interface LayoutAuditOptions {
  /** Report controls smaller than 44 by 44 CSS pixels. */
  touchTargets?: boolean;
  /** Report main content, the top bar, or prose wider than the readable limits. */
  measure?: boolean;
  /** Pixels of tolerance for sub-pixel rounding. */
  tolerance?: number;
  /** Audit only elements inside these selectors, and skip the document-wide width checks. */
  within?: string[];
}

/** The app content is capped at --app-max (1600px) including its side gutters (2rem = 32px each at wide widths),
 *  so main is at most 1600 - 2 * 32 = 1536px. */
export const MAX_MAIN_CONTENT_PX = 1536;
export const MAX_PROSE_PX = 1000;
export const MIN_TARGET_PX = 44;
/** A text field narrower than this cannot show a short value such as an amount. */
export const MIN_FIELD_PX = 96;
/** Outcome cards add columns only when each card keeps this width. */
export const MIN_OUTCOME_CARD_PX = 280;

export async function auditLayout(page: Page, options: LayoutAuditOptions = {}): Promise<string[]> {
  return page.evaluate(({ touchTargets, measure, tolerance, limits, within }) => {
    const issues: string[] = [];
    const viewportWidth = document.documentElement.clientWidth;

    const describe = (element: Element): string => {
      const parts: string[] = [element.tagName.toLowerCase()];
      if (element.id) parts.push(`#${element.id}`);
      const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean) : [];
      if (classes.length) parts.push(`.${classes.slice(0, 3).join('.')}`);
      const label = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
      if (label) parts.push(`"${label}"`);
      return parts.join('');
    };

    const isBackground = (element: Element) => Boolean(element.closest('.bg'));
    const isScreenReaderOnly = (element: Element) => Boolean(element.closest('.sr-only'));
    const visible = (element: Element): boolean => {
      if (isBackground(element) || isScreenReaderOnly(element)) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const scoped = (element: Element) => within.length === 0 || within.some((selector) => element.closest(selector));
    const all = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((element) => visible(element) && scoped(element));

    // 1. Page overflow.
    const root = document.documentElement;
    if (within.length === 0 && root.scrollWidth > viewportWidth + tolerance) {
      issues.push(`page: document scrollWidth ${root.scrollWidth} exceeds viewport ${viewportWidth}`);
    }
    if (within.length === 0 && document.body.scrollWidth > viewportWidth + tolerance) {
      issues.push(`page: body scrollWidth ${document.body.scrollWidth} exceeds viewport ${viewportWidth}`);
    }
    for (const element of all) {
      const style = getComputedStyle(element);
      if (style.position === 'fixed' && element.getBoundingClientRect().height === 0) continue;
      for (const rect of Array.from(element.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.left < -tolerance || rect.right > viewportWidth + tolerance) {
          issues.push(`page: ${describe(element)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${viewportWidth}`);
          break;
        }
      }
    }

    // 2. Region overflow, clipping, and truncation.
    const clips = (style: CSSStyleDeclaration) => style.overflowX !== 'visible' || style.overflowY !== 'visible';
    for (const element of all) {
      const style = getComputedStyle(element);
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        // A text field scrolls its own text by design. It is only a defect when the field is too
        // narrow to use, or when a short value such as an amount does not fit in full.
        const textual = !(element instanceof HTMLInputElement) || !['checkbox', 'radio', 'hidden', 'range', 'color', 'file'].includes(element.type);
        if (textual) {
          const width = element.getBoundingClientRect().width;
          if (width < limits.field - tolerance) issues.push(`field: ${describe(element)} is only ${Math.round(width)}px wide`);
          const value = 'value' in element ? String(element.value) : '';
          const amount = element instanceof HTMLInputElement && ['decimal', 'numeric'].includes(element.inputMode);
          if (amount && value.length > 0 && element.scrollWidth > element.clientWidth + tolerance) {
            issues.push(`field: ${describe(element)} cuts its value "${value}" (scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth})`);
          }
        }
        continue;
      }
      if (clips(style) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + tolerance) {
        const kind = style.overflowX === 'auto' || style.overflowX === 'scroll' ? 'scrolls horizontally' : 'clips its content';
        issues.push(`region: ${describe(element)} ${kind} (scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth})`);
      }
      if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + tolerance) {
        issues.push(`truncated: ${describe(element)} cuts text with an ellipsis`);
      }
    }
    const clippingAncestor = (element: Element): HTMLElement | null => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'hidden' || style.overflowX === 'clip') return node;
      }
      return null;
    };
    for (const element of all) {
      const style = getComputedStyle(element);
      if (style.position === 'absolute' || style.position === 'fixed') continue;
      const ancestor = clippingAncestor(element);
      if (!ancestor || ancestor === document.documentElement) continue;
      const box = ancestor.getBoundingClientRect();
      for (const rect of Array.from(element.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > box.right + tolerance || rect.left < box.left - tolerance) {
          issues.push(`clipped: ${describe(element)} sticks out of ${describe(ancestor)}`);
          break;
        }
      }
    }

    // 3. Overlap between text blocks and controls on the same layer.
    const layerOf = (element: Element): Element | null => {
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') return node;
      }
      return null;
    };
    const hasOwnText = (element: Element) => Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
    );
    const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="button"]';
    const atoms = all.filter((element) => {
      const style = getComputedStyle(element);
      if (style.position === 'absolute') return false;
      if (element.closest('[aria-hidden="true"]') && !element.matches(interactive)) return false;
      return element.matches(interactive) || hasOwnText(element);
    });
    const rectsOf = (element: Element) => Array.from(element.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    const layers = atoms.map(layerOf);
    const rects = atoms.map(rectsOf);
    for (let i = 0; i < atoms.length; i += 1) {
      for (let j = i + 1; j < atoms.length; j += 1) {
        if (layers[i] !== layers[j]) continue;
        const a = atoms[i] as HTMLElement;
        const b = atoms[j] as HTMLElement;
        if (a.contains(b) || b.contains(a)) continue;
        const overlaps = (rects[i] as DOMRect[]).some((first) => (rects[j] as DOMRect[]).some((second) => {
          const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
          const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
          return width > tolerance && height > tolerance;
        }));
        if (overlaps) issues.push(`overlap: ${describe(a)} and ${describe(b)}`);
      }
    }

    // Outcome cards share a row only when each keeps at least 280 CSS pixels (design contract).
    const cards = all.filter((element) => element.matches('article.clarity-outcome'));
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = (cards[i] as HTMLElement).getBoundingClientRect();
        const b = (cards[j] as HTMLElement).getBoundingClientRect();
        const sameRow = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 20;
        const sideBySide = a.right <= b.left + tolerance || b.right <= a.left + tolerance;
        if (!sameRow || !sideBySide) continue;
        for (const [card, rect] of [[cards[i], a], [cards[j], b]] as const) {
          if (rect.width < limits.card - tolerance) {
            issues.push(`columns: ${describe(card as Element)} shares a row at ${Math.round(rect.width)}px, below ${limits.card}px`);
          }
        }
      }
    }

    // 4. Touch targets.
    if (touchTargets) {
      const targets = all.filter((element) => {
        if (!element.matches(interactive)) return false;
        // Footer links sit in a line of text, like inline links.
        if (element.closest('footer')) return false;
        if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) return false;
        const style = getComputedStyle(element);
        // Links inside a sentence are exempt: they size to the surrounding text.
        if (element.tagName === 'A' && style.display === 'inline') {
          const parent = element.parentElement;
          if (parent && (parent.textContent ?? '').trim().length > (element.textContent ?? '').trim().length) return false;
        }
        return true;
      });
      for (const element of targets) {
        const rect = element.getBoundingClientRect();
        if (rect.width < limits.target - tolerance || rect.height < limits.target - tolerance) {
          issues.push(`target: ${describe(element)} is ${Math.round(rect.width)}x${Math.round(rect.height)}, below ${limits.target}x${limits.target}`);
        }
      }
    }

    // 5. Readable measure.
    if (measure) {
      const main = document.querySelector('main');
      if (main && main.getBoundingClientRect().width > limits.main + tolerance) {
        issues.push(`measure: main is ${Math.round(main.getBoundingClientRect().width)}px wide, above ${limits.main}px`);
      }
      const bar = document.querySelector<HTMLElement>('.topbar');
      if (bar) {
        const brand = bar.querySelector('.brand')?.getBoundingClientRect();
        const actions = bar.querySelector('.top-actions')?.getBoundingClientRect();
        if (brand && actions && actions.right - brand.left > limits.main + 240 + tolerance) {
          issues.push(`measure: top bar content spans ${Math.round(actions.right - brand.left)}px, above ${limits.main + 240}px`);
        }
      }
      // A reader meets the width of a line of text, not the width of the box around it. A list row
      // is a flex row of separate parts, so its box can be wide while every line in it is short.
      // Measure the widest rendered line of text inside each paragraph and list item.
      const widestLine = (element: Element): number => {
        let widest = 0;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').trim().length === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) widest = Math.max(widest, rect.width);
        }
        return widest;
      };
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('main p, main li'))) {
        if (!visible(element) || (element.textContent ?? '').trim().length < 90) continue;
        const width = widestLine(element);
        if (width > limits.prose + tolerance) {
          issues.push(`measure: ${describe(element)} has a ${Math.round(width)}px text line, above ${limits.prose}px`);
        }
      }
    }

    return Array.from(new Set(issues));
  }, {
    touchTargets: options.touchTargets === true,
    measure: options.measure === true,
    tolerance: options.tolerance ?? 1,
    limits: { target: MIN_TARGET_PX, main: MAX_MAIN_CONTENT_PX, prose: MAX_PROSE_PX, field: MIN_FIELD_PX, card: MIN_OUTCOME_CARD_PX },
    within: options.within ?? [],
  });
}

/** Scales the root font size, the way a browser text-size setting of 200% does. */
export async function scaleText(page: Page, percent: number): Promise<void> {
  await page.addStyleTag({ content: `html { font-size: ${percent}% !important; }` });
}

/** Scrolls to the end of the page and returns what is still under the fixed bottom navigation. */
export async function contentHiddenByBottomNavigation(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav.bottom-tabs');
    if (!nav || getComputedStyle(nav).display === 'none') return [];
    // An open dialog locks page scrolling and covers the navigation, so there is nothing to scroll clear of.
    if (document.querySelector('[role="dialog"]')) return [];
    window.scrollTo(0, document.documentElement.scrollHeight);
    const top = nav.getBoundingClientRect().top;
    const main = document.querySelector('main');
    if (!main) return [];
    const hidden: string[] = [];
    for (const element of Array.from(main.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // The last piece of content must be scrollable clear of the bar.
      if (rect.bottom > top + 1 && rect.top < window.innerHeight && element.children.length === 0) {
        hidden.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 28)}"`);
      }
    }
    return hidden;
  });
}

/** Waits for finite entrance animations and transitions to finish, so the audit sees the settled layout. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // A progress animation such as the 8-second Undo bar is not an entrance, and a paused one never ends.
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing !== undefined && timing.iterations !== Infinity && Number(timing.endTime) <= 3000;
    });
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}
