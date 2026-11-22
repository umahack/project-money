import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Pins the shell layout contract to the real stylesheets (jsdom does not apply them):
 * the header navigation from 900px, the bottom bar below it, a sticky header, no sidebar column,
 * and a content width that uses large screens without unbounded lines.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const monthly = readFileSync(resolve(SRC, 'components/dashboard/monthlyClarity.css'), 'utf8');
/** The "App shell and primary navigation" section of styles.css, up to the next section. */
const shellSection = stylesheet.slice(
  stylesheet.indexOf('/* ---- App shell and primary navigation'),
  stylesheet.indexOf('/* ---- Admin overview cards'),
);

/** The declarations of the first rule whose selector list contains `selector`, outside any media query. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (!match) throw new Error(`No top-level rule for ${selector}`);
  return match[1]!;
}

/** The bodies of every `@media (min-width: Npx)` block from `after` on, joined, each matched by brace depth. */
function mediaMinWidth(source: string, width: number, after = 0): string {
  const bodies: string[] = [];
  for (let start = source.indexOf(`@media (min-width: ${width}px) {`, after); start >= 0; start = source.indexOf(`@media (min-width: ${width}px) {`, start + 1)) {
    let depth = 0;
    const open = source.indexOf('{', start);
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(open + 1, i));
          break;
        }
      }
    }
  }
  if (bodies.length === 0) throw new Error(`No @media (min-width: ${width}px) block`);
  return bodies.join('\n');
}

describe('shell layout', () => {
  it('shows the header navigation from 900px and the bottom bar below it, never both', () => {
    expect(rule(stylesheet, '.primary-nav')).toMatch(/display:\s*none/);
    const desktop = mediaMinWidth(shellSection, 900);
    expect(desktop).toMatch(/\.primary-nav\s*\{[^}]*display:\s*flex/);
    // The same breakpoint hides the mobile-only bottom bar.
    expect(mediaMinWidth(stylesheet, 900)).toMatch(/\.mobile-only\s*\{\s*display:\s*none/);
    expect(rule(stylesheet, '.mobile-only')).toMatch(/display:\s*flex/);
  });

  it('keeps the header sticky and does not make the page body a scroll container that would break it', () => {
    const topbar = rule(stylesheet, '.topbar');
    expect(topbar).toMatch(/position:\s*sticky/);
    expect(topbar).toMatch(/top:\s*0/);
    // `overflow-x: hidden` on body turns it into a scroll container that never scrolls, and a sticky header
    // inside it then never sticks. From 900px, where the header carries the navigation, body clips instead.
    expect(mediaMinWidth(stylesheet, 900)).toMatch(/\bbody\s*\{\s*overflow-x:\s*clip/);
  });

  it('has no sidebar column: the content spans the app width, capped at a sensible maximum', () => {
    expect(stylesheet).not.toMatch(/\.sidebar|\.side-link|\.side-nav|grid-template-columns:\s*232px/);
    const desktop = mediaMinWidth(shellSection, 900);
    expect(desktop).not.toMatch(/grid-template-columns/);
    expect(desktop).toMatch(/\.app-shell\s*\{[^}]*max-width:\s*var\(--app-max\)/);
    const max = /--app-max:\s*(\d+)px/.exec(stylesheet);
    expect(max).not.toBeNull();
    const pixels = Number(max![1]);
    expect(pixels).toBeGreaterThanOrEqual(1440);
    expect(pixels).toBeLessThanOrEqual(1600);
  });

  it('marks the current page with more than colour and shows keyboard focus', () => {
    const current = /\n\.primary-link\[aria-current='page'\]\s*\{([^}]*)\}/.exec(stylesheet);
    expect(current).not.toBeNull();
    // A tint, a different text colour, and an underline bar.
    expect(current![1]).toMatch(/background:/);
    expect(current![1]).toMatch(/border-bottom-color:/);
    expect(rule(stylesheet, '.primary-link')).toMatch(/border-bottom:\s*3px solid transparent/);
    expect(stylesheet).toMatch(/\.primary-link:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  });

  it('keeps the header in reading order: nothing is reordered with CSS, the links wrap inside their own box, and the actions drop below them', () => {
    // Moving the navigation below the actions with `order` made Tab (brand, links, actions) contradict the
    // screen (brand, actions, links) between 900px and 1319px (WCAG 1.3.2 and 2.4.3). Flex wrapping alone keeps the two the same.
    const withoutComments = shellSection.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/(^|[\s;{])order\s*:/);
    const wrapped = mediaMinWidth(shellSection, 900);
    expect(wrapped).toMatch(/\.primary-nav\s*\{[^}]*flex-wrap:\s*wrap[^}]*flex:\s*1 1 auto/s);
    expect(wrapped).toMatch(/\.topbar \.top-actions\s*\{[^}]*margin-left:\s*auto/);
    expect(mediaMinWidth(shellSection, 1320)).toMatch(/\.primary-nav\s*\{[^}]*justify-content:\s*center/);
  });
});

describe('Home key-number row', () => {
  it('uses an auto-fit grid with a 280px minimum, and avoids a short last row at the widths where auto-fit would leave one', () => {
    expect(rule(monthly, '.monthly-clarity-grid')).toMatch(/repeat\(auto-fit,\s*minmax\(min\(100%,\s*17\.5rem\),\s*1fr\)\)/);
    // Four cards go 2 + 2 where auto-fit would make 3 + 1; three cards span the last cell where they would make 2 + 1.
    expect(monthly).toMatch(/\[data-count='4'\]\s*\{\s*grid-template-columns:\s*repeat\(2,/);
    expect(monthly).toMatch(/\[data-count='3'\]\s*>\s*:last-child\s*\{\s*grid-column:\s*1 \/ -1/);
  });
});
const clarity = readFileSync(resolve(SRC, 'components/clarity/clarity.css'), 'utf8');
describe('Home equal-height rows and compact top', () => {
  it('stretches the key-number cards and the journey/streak cards to one height per row', () => {
    expect(rule(monthly, '.monthly-clarity-grid')).toMatch(/align-items:\s*stretch/);
    expect(rule(monthly, '.home-secondary')).toMatch(/align-items:\s*stretch/);
    expect(monthly).toMatch(/\.monthly-clarity-region\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column/);
    expect(monthly).toMatch(/\.monthly-clarity-region > \.card\s*\{\s*flex:\s*1 1 auto/);
    // The first trailing control of a card takes the free space above it, so actions sit at the bottom.
    expect(monthly).toMatch(/clarity-outcome-footer\)\s*~\s*\*\)\s*\{\s*margin-top:\s*auto/);
  });
  // The Plan row is the one two-card row that does NOT stretch. Its cards hold very different amounts (the pay card:
  // explanations and a short form; the bills card: a list and an add form), so stretching the pay card to the bills
  // card's height left about 500px of blank space between its explanations and its form. Home and Trips hold similar
  // amounts in a row and keep the equal-height behaviour (asserted above and below).
  it('lets the Plan pay and bills cards keep their own height from 900px, and keeps the stretch on Trips', () => {
    const plan = readFileSync(resolve(SRC, 'components/plan/plan.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const trips = readFileSync(resolve(SRC, 'components/trips/trips.css'), 'utf8');
    expect(mediaMinWidth(plan, 900)).toMatch(/main\.clarity-on \.plan-inputs-row\s*\{\s*align-items:\s*start/);
    // No stretch, no flex column with an auto margin that pushes the form to the card's bottom edge.
    expect(plan).not.toMatch(/\.plan-inputs-row[^{]*\{[^}]*align-items:\s*stretch/);
    expect(plan).not.toMatch(/\.plan-inputs-row[^{]*\{[^}]*display:\s*flex/);
    expect(plan).not.toMatch(/\.salary-form\s*\{[^}]*margin-top:\s*auto/);
    expect(trips).toMatch(/main\.clarity-on \.trip-grid\s*\{\s*align-items:\s*stretch/);
  });
  it('lays Next actions out in 2 or 3 columns of at least 20rem from 1100px, and as one column below', () => {
    const wide = mediaMinWidth(monthly, 1100);
    expect(wide).toMatch(/\.monthly-clarity-action-list\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*max\(20rem,\s*calc\(\(100% - 2\.1rem\) \/ 3\)\)\),\s*1fr\)\)/);
    expect(rule(monthly, '.monthly-clarity-action-list')).not.toMatch(/grid-template-columns/);
  });
  it('arranges the Spending, Plan and Goals values in an auto-fit grid of at most four columns, with notes spanning the row', () => {
    expect(clarity).toMatch(/:is\(\.spending-values, \.plan-values, \.goal-values\)\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*max\(15rem,/);
    expect(clarity).toMatch(/> :not\(\.clarity-value\)\s*\{\s*grid-column:\s*1 \/ -1/);
  });
  it('shows the quick actions as a 2x2 grid of 48px tiles on phones and one row of four from 600px, for the clarity pages only', () => {
    expect(clarity).toMatch(/main\.clarity-on \.quick-actions\s*\{[^}]*minmax\(min\(100%,\s*max\(8rem,\s*45%\)\),\s*1fr\)/);
    expect(mediaMinWidth(clarity, 600)).toMatch(/\.quick-actions\s*\{\s*grid-template-columns:\s*repeat\(4,/);
    expect(clarity).toMatch(/main\.clarity-on \.qa-tile\s*\{[^}]*min-height:\s*48px/);
    // The flag-off Home keeps its original tile rules: nothing for .qa-tile outside `main.clarity-on` changed to a row layout.
    expect(rule(stylesheet, '.qa-tile')).toMatch(/flex-direction:\s*column/);
  });
});
