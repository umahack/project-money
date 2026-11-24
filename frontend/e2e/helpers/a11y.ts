// Accessibility helpers for the real-browser acceptance specs (task 17.4, Requirement 12).
//
// jsdom cannot compute layout or colour, so everything here runs in Chromium against the real,
// unmodified CSS:
//
// - `runAxe` injects the installed `axe-core` into the page (no extra dependency) and runs the
//   WCAG 2.x A/AA and best-practice rules with colour-contrast ENABLED,
// - `auditContrast` measures every text node, status glyph, and form-field boundary with the
//   WCAG relative-luminance formula. It resolves translucent layers by compositing them, and it
//   evaluates the animated background (the dark theme's colour blobs) at its worst point, so a
//   pass here means the text stays readable wherever the background drifts,
// - `measureFocus` measures the indicator of the focused element (outline or box-shadow), its
//   contrast against the surrounding colour, and whether any clipping ancestor cuts it off,
// - `collectFocusStops` presses Tab through the page and measures every stop.
import { createRequire } from 'node:module';
import { expect, type Locator, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
const AXE_SOURCE_PATH = require.resolve('axe-core/axe.min.js');

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** Waits for every finite CSS transition and animation to end, so colours are read at rest and not mid-fade. */
export async function waitForTransitions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let round = 0; round < 6; round += 1) {
      // A progress animation such as the 8-second Undo bar is not a fade or a transition, and a paused one never ends.
      const running = document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return timing !== undefined && timing.iterations !== Infinity && Number(timing.endTime) <= 3000;
      });
      if (running.length === 0) return;
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

/** Switches theme the way the shell does and waits until the colours (which transition for 0.2 s) have settled. */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await waitForTransitions(page);
}

/** The thresholds of WCAG 2.x AA (Requirements 12.11 to 12.13). */
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_LARGE_TEXT_CONTRAST = 3;
export const MIN_COMPONENT_CONTRAST = 3;

/**
 * Waits until nothing on the page is part-way through an opacity fade. The page and its cards fade in with a
 * JavaScript animation (Framer Motion) that `document.getAnimations()` cannot see, and a text node measured
 * mid-fade reads as lighter than it is. Disabled controls sit at a constant opacity and are ignored.
 */
export async function waitForSteadyColors(page: Page, timeoutMs = 4000): Promise<void> {
  await page.evaluate(async (limit) => {
    const deadline = performance.now() + limit;
    const fading = () => Array.from(document.querySelectorAll<HTMLElement>('main *, nav *, header *'))
      .some((element) => {
        if (!element.hasAttribute('style') || !/opacity|transform/.test(element.getAttribute('style') ?? '')) return false;
        const value = Number(getComputedStyle(element).opacity);
        return value > 0.001 && value < 0.999;
      });
    let steady = 0;
    while (performance.now() < deadline && steady < 5) {
      steady = fading() ? 0 : steady + 1;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, timeoutMs);
}

// ---- axe-core ---------------------------------------------------------------------------------------------

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] as const;


interface AxeNodeResult { target: unknown[]; html: string; any?: Array<{ message?: string; data?: unknown }> }
interface AxeRuleResult { id: string; impact?: string | null; help: string; nodes: AxeNodeResult[] }
interface AxeRunResult { violations: AxeRuleResult[]; incomplete: AxeRuleResult[] }
interface AxeWindow { axe?: { run(context: unknown, options: unknown): Promise<AxeRunResult> } }

async function ensureAxe(page: Page): Promise<void> {
  const present = await page.evaluate(() => Boolean((window as unknown as AxeWindow).axe));
  if (!present) await page.addScriptTag({ path: AXE_SOURCE_PATH });
}

export interface AxeOptions {
  /** Restrict the run to this part of the page (for example an open dialog). */
  include?: string;
}

/**
 * Runs axe-core with every WCAG 2.x A/AA and best-practice rule, colour-contrast included.
 * Returns the violations and, separately, the colour-contrast checks axe could not decide
 * (a gradient or an overlapping element), which `auditContrast` measures itself.
 */
export async function runAxe(page: Page, options: AxeOptions = {}): Promise<{ violations: string[]; undecidedContrast: string[] }> {
  await ensureAxe(page);
  await waitForSteadyColors(page);
  const result = await page.evaluate(async ({ tags, include }) => {
    const axe = (window as unknown as AxeWindow).axe!;
    const run = await axe.run(include ? { include: [include] } : document, {
      runOnly: { type: 'tag', values: [...tags] },
      resultTypes: ['violations', 'incomplete'],
    });
    const nodes = (rule: AxeRuleResult) => rule.nodes.map((node) => `${rule.id} [${rule.impact ?? '?'}] ${node.target.join(' ')} :: ${node.html.slice(0, 110)}${
      node.any?.[0]?.message ? ` :: ${node.any[0].message.slice(0, 160)}` : ''
    }`);
    // The one narrow exception to the rules: axe-core's experimental `label-content-name-mismatch`
    // check compares a button's whole visible text with its accessible name. Each journey outcome choice is a
    // card whose name is its title (aria-labelledby) and whose description is exposed as the accessible
    // description, so a person who says the visible title ("Plan the month") activates it. The extra visible
    // lines are supplementary text, not the control's label (WCAG 2.5.3 asks that the label be in the name,
    // and the title is). Every other node, and every other rule, is still reported.
    const isJourneyChoiceLabel = (rule: AxeRuleResult, node: AxeNodeResult) => (
      rule.id === 'label-content-name-mismatch' && node.html.includes('class="journey-choice"')
    );
    const reported = run.violations.map((rule) => ({
      ...rule,
      nodes: rule.nodes.filter((node) => !isJourneyChoiceLabel(rule, node)),
    })).filter((rule) => rule.nodes.length > 0);
    return {
      violations: reported.flatMap(nodes),
      undecidedContrast: run.incomplete.filter((rule) => rule.id === 'color-contrast').flatMap(nodes),
    };
  }, { tags: AXE_TAGS, include: options.include ?? null });
  return result;
}

// ---- Contrast ---------------------------------------------------------------------------------------------

export interface ContrastReport {
  /** One readable line per failure. */
  issues: string[];
  /** How many text nodes, glyphs, and fields were measured, so a pass cannot be an empty pass. */
  measured: { text: number; glyph: number; field: number };
}

/**
 * Measures the page's text, status glyphs, and field boundaries. Text is large at 24 px, or at
 * 18.66 px when bold (18 and 14 points). Disabled controls are exempt, as WCAG 1.4.3 allows.
 * The footer signature and the ₹ brand mark are excluded: they are logotypes, which WCAG 1.4.3 exempts.
 * Everything else, decorative or not, is measured. Placeholder text and the fill of chart bars are measured too.
 */
export async function auditContrast(page: Page, options: { within?: string } = {}): Promise<ContrastReport> {
  await waitForSteadyColors(page);
  return page.evaluate(({ within, limits }) => {
    type Rgba = [number, number, number, number];
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const parse = (css: string): Rgba => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0]!, data[1]!, data[2]!, data[3]! / 255];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      const mix = (a: number, b: number) => (a * top[3] + b * bottom[3] * (1 - top[3])) / alpha;
      return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), alpha];
    };
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: Rgba) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    const ratio = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const hex = (c: Rgba) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}${c[3] < 1 ? `, ${c[3].toFixed(2)}` : ''})`;
    const describe = (element: Element): string => {
      const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes.length ? `.${classes.join('.')}` : ''} "${text}"`;
    };

    // What can paint behind the page content: the body colour is covered by the fixed `.bg`
    // layer (a radial gradient from --bg-2 to --bg) with the colour blobs drifting above it.
    // Every blob is taken at its strongest, so the result holds wherever the blobs are.
    const rootStyle = getComputedStyle(document.documentElement);
    const pageBase = parse(getComputedStyle(document.body).backgroundColor);
    const baseColor: Rgba = pageBase[3] > 0 ? [pageBase[0], pageBase[1], pageBase[2], 1] : [255, 255, 255, 1];
    const bgTwo = parse(rootStyle.getPropertyValue('--bg-2').trim() || hex(baseColor));
    const backdrops: Rgba[] = [baseColor, [bgTwo[0], bgTwo[1], bgTwo[2], 1]];
    for (const blob of Array.from(document.querySelectorAll<HTMLElement>('.bg .blob'))) {
      const style = getComputedStyle(blob);
      const opacity = Number(style.opacity);
      if (!(opacity > 0)) continue;
      const color = parse(style.backgroundColor);
      backdrops.push(over([color[0], color[1], color[2], opacity], baseColor));
    }

    const stopsOf = (image: string): Rgba[] => (
      (image.match(/rgba?\([^)]*\)|color\([^)]*\)/g) ?? []).map(parse)
    );
    /** Possible opaque backgrounds behind an element: its ancestors' layers over each backdrop. */
    const backgroundsBehind = (start: Element | null): Rgba[] => {
      const layers: Rgba[][] = [];
      let opaque = false;
      for (let node: Element | null = start; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const image = style.backgroundImage;
        const color = parse(style.backgroundColor);
        if (image !== 'none' && !node.closest('.bg')) {
          const stops = stopsOf(image);
          if (stops.length > 0) {
            layers.push(stops);
            if (stops.every((stop) => stop[3] === 1)) { opaque = true; break; }
            continue;
          }
        }
        if (color[3] > 0) {
          layers.push([color]);
          if (color[3] === 1) { opaque = true; break; }
        }
      }
      let results: Rgba[] = opaque ? [[0, 0, 0, 1]] : backdrops;
      if (opaque) {
        // The first layer collected last is the opaque one; start from it.
        const bottom = layers.pop()!;
        results = bottom.map((c) => c);
      }
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        const layer = layers[index]!;
        const next: Rgba[] = [];
        for (const below of results) for (const top of layer) next.push(over(top, below));
        results = next;
      }
      return results.map((c) => [c[0], c[1], c[2], 1] as Rgba);
    };

    const visible = (element: Element): boolean => {
      if (element.closest('.bg, .sr-only, [hidden], template, script, style')) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const cumulativeOpacity = (element: Element): number => {
      let value = 1;
      for (let node: Element | null = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
      return value;
    };
    const disabled = (element: Element) => Boolean(element.closest('[disabled], [aria-disabled="true"], fieldset:disabled'));
    const scope = within ? Array.from(document.querySelectorAll(within)) : [document.body];
    const inScope = (element: Element) => scope.some((root) => root.contains(element));

    const issues: string[] = [];
    const measured = { text: 0, glyph: 0, field: 0 };
    const worst = (foreground: Rgba, backgrounds: Rgba[]) => {
      let low = Infinity;
      let lowBackground = backgrounds[0]!;
      for (const background of backgrounds) {
        const composed = over(foreground, background);
        const value = ratio(composed, background);
        if (value < low) { low = value; lowBackground = background; }
      }
      return { ratio: low, background: lowBackground };
    };

    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (!inScope(element) || !visible(element)) continue;
      const ownText = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0);
      if (!ownText || disabled(element)) continue;
      // The footer signature and the ₹ brand mark are logotypes, which WCAG 1.4.3 exempts from the
      // minimum. They are the only exclusions; every other piece of text is measured.
      if (element.closest('.signature, .brand-mark')) continue;
      const style = getComputedStyle(element);
      let color = parse(style.color);
      if (style.webkitTextFillColor && style.webkitTextFillColor !== style.color) color = parse(style.webkitTextFillColor);
      if (color[3] === 0) continue;
      color = [color[0], color[1], color[2], color[3] * cumulativeOpacity(element)];
      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const decorative = element.getAttribute('aria-hidden') === 'true' || Boolean(element.closest('[aria-hidden="true"]'));
      const required = decorative || large ? limits.large : limits.text;
      const result = worst(color, backgroundsBehind(element));
      if (decorative) measured.glyph += 1; else measured.text += 1;
      if (result.ratio < required) {
        issues.push(`${decorative ? 'glyph' : 'text'} ${describe(element)} ${(Math.round(result.ratio * 100) / 100).toFixed(2)}:1 < ${required}:1 (${hex(color)} on ${hex(result.background)}; ${size}px weight ${weight}${large ? ' large' : ''})`);
      }
    }

    // A text field's edge is what tells a person where to type, so its border (or, with no border,
    // its fill) must stand out from the surface around it by 3:1 (WCAG 1.4.11).
    const fields = Array.from(document.body.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), select, textarea',
    ));
    for (const field of fields) {
      if (!inScope(field) || !visible(field) || disabled(field)) continue;
      const style = getComputedStyle(field);
      const surround = backgroundsBehind(field.parentElement);
      const borderWidth = parseFloat(style.borderTopWidth);
      const border = borderWidth > 0 && style.borderTopStyle !== 'none' ? parse(style.borderTopColor) : [0, 0, 0, 0] as Rgba;
      const fill = parse(style.backgroundColor);
      let best = 0;
      let background = surround[0]!;
      for (const below of surround) {
        const edge = ratio(over(border, below), below);
        const body = fill[3] > 0 ? ratio(over(fill, below), below) : 1;
        const strongest = Math.max(border[3] > 0 ? edge : 1, body);
        if (best === 0 || strongest < best) { best = strongest; background = below; }
      }
      measured.field += 1;
      if (best < limits.component) {
        issues.push(`field ${describe(field)} edge ${(Math.round(best * 100) / 100).toFixed(2)}:1 < ${limits.component}:1 (border ${hex(border)}, fill ${hex(fill)}, on ${hex(background)})`);
      }
    }
    // Placeholder text is text (WCAG 1.4.3): measure it against the field's own fill.
    for (const field of fields) {
      if (!inScope(field) || !visible(field) || disabled(field)) continue;
      const placeholder = field.getAttribute('placeholder');
      if (!placeholder || (field as HTMLInputElement).value) continue;
      const placeholderStyle = getComputedStyle(field, '::placeholder');
      const color = parse(placeholderStyle.color);
      const opacity = Number(placeholderStyle.opacity);
      const fill = parse(getComputedStyle(field).backgroundColor);
      let low = Infinity;
      let lowBackground: Rgba = [255, 255, 255, 1];
      for (const below of backgroundsBehind(field.parentElement)) {
        const bottom = over(fill, below);
        const value = ratio(over([color[0], color[1], color[2], color[3] * opacity], bottom), bottom);
        if (value < low) { low = value; lowBackground = bottom; }
      }
      measured.text += 1;
      if (low < limits.text) {
        issues.push(`placeholder ${describe(field)} ${(Math.round(low * 100) / 100).toFixed(2)}:1 < ${limits.text}:1 (${hex(color)} at ${opacity} on ${hex(lowBackground)})`);
      }
    }

    // Chart elements carry meaning by their colour, so each bar and swatch needs 3:1 against the
    // track or card it sits on (WCAG 1.4.11). A gradient is measured at every stop.
    const chartParts = Array.from(document.body.querySelectorAll<HTMLElement>('.bar-fill, .progress-fill, .legend i, .donut-seg'));
    for (const part of chartParts) {
      if (!inScope(part) || !visible(part)) continue;
      const style = getComputedStyle(part);
      const stops = style.backgroundImage !== 'none' ? stopsOf(style.backgroundImage) : [parse(style.backgroundColor)];
      if (stops.length === 0 || stops.every((stop) => stop[3] === 0)) continue;
      let low = Infinity;
      let lowBackground: Rgba = [255, 255, 255, 1];
      for (const below of backgroundsBehind(part.parentElement)) {
        for (const stop of stops) {
          const value = ratio(over(stop, below), below);
          if (value < low) { low = value; lowBackground = below; }
        }
      }
      measured.glyph += 1;
      if (low < limits.component) {
        issues.push(`chart ${describe(part)} ${(Math.round(low * 100) / 100).toFixed(2)}:1 < ${limits.component}:1 (fill ${style.backgroundImage !== 'none' ? 'gradient' : style.backgroundColor} on ${hex(lowBackground)})`);
      }
    }
    return { issues, measured };
  }, {
    within: options.within ?? null,
    limits: { text: MIN_TEXT_CONTRAST, large: MIN_LARGE_TEXT_CONTRAST, component: MIN_COMPONENT_CONTRAST },
  });
}

export async function expectContrast(page: Page, label: string, options: { within?: string; minimumTextNodes?: number } = {}): Promise<ContrastReport> {
  const report = await auditContrast(page, options);
  expect.soft(report.issues, `${label}: contrast`).toEqual([]);
  expect.soft(report.measured.text, `${label}: the contrast audit measured no text`).toBeGreaterThanOrEqual(options.minimumTextNodes ?? 3);
  return report;
}

// ---- Focus ------------------------------------------------------------------------------------------------

export interface FocusMeasurement {
  element: string;
  /** What draws the indicator: an outline, a box-shadow ring, or nothing. */
  kind: 'outline' | 'box-shadow' | 'none';
  /** Contrast of the indicator against the colour around the element. */
  ratio: number;
  thickness: number;
  /** An ancestor that clips the indicator, or a viewport edge that cuts it off. */
  clippedBy: string | null;
  inViewportHorizontally: boolean;
}

/** Measures the indicator of `document.activeElement`. */
export async function measureFocus(page: Page): Promise<FocusMeasurement | null> {
  // Controls fade their colours over 0.2 s when they gain focus; measure the ring at rest.
  await waitForTransitions(page);
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    type Rgba = [number, number, number, number];
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const parse = (css: string): Rgba => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0]!, data[1]!, data[2]!, data[3]! / 255];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      const mix = (a: number, b: number) => (a * top[3] + b * bottom[3] * (1 - top[3])) / alpha;
      return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), alpha];
    };
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: Rgba) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    const ratio = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const describe = (node: Element): string => {
      const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      const label = node.getAttribute('aria-label') ?? (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
      return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes.length ? `.${classes.join('.')}` : ''} "${label}"`;
    };
    /** The opaque colour that shows around `start`, from the nearest opaque ancestor layer down. */
    const surround = (start: Element | null): Rgba => {
      const layers: Rgba[] = [];
      for (let node: Element | null = start; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const stops = style.backgroundImage !== 'none' && !node.closest('.bg')
          ? (style.backgroundImage.match(/rgba?\([^)]*\)|color\([^)]*\)/g) ?? []).map(parse)
          : [];
        // A gradient is taken at its stop that is closest to the indicator colour later; use the first stop here.
        const color = stops.length > 0 ? stops[0]! : parse(style.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] === 1) break;
      }
      const rootBase = parse(getComputedStyle(document.body).backgroundColor);
      let result: Rgba = rootBase[3] > 0 ? [rootBase[0], rootBase[1], rootBase[2], 1] : [255, 255, 255, 1];
      for (let index = layers.length - 1; index >= 0; index -= 1) result = over(layers[index]!, result);
      return result;
    };

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    let kind: FocusMeasurement['kind'] = 'none';
    let indicator: Rgba = [0, 0, 0, 0];
    let thickness = 0;
    let reach = 0;
    let inside = false;
    const outlineWidth = parseFloat(style.outlineWidth);
    if (style.outlineStyle !== 'none' && outlineWidth > 0) {
      kind = 'outline';
      indicator = parse(style.outlineColor);
      thickness = outlineWidth;
      const offset = parseFloat(style.outlineOffset) || 0;
      reach = offset + outlineWidth;
      inside = offset < 0;
    } else if (style.boxShadow !== 'none') {
      // Only a ring (no blur) counts: `0 0 0 Npx colour`. A soft glow is measured the same way.
      const shadow = style.boxShadow.split(/,(?![^(]*\))/)[0]!.trim();
      const colorMatch = shadow.match(/rgba?\([^)]*\)|color\([^)]*\)/);
      const lengths = shadow.replace(/rgba?\([^)]*\)|color\([^)]*\)/, '').trim().split(/\s+/).filter((part) => part && part !== 'inset').map(parseFloat);
      if (colorMatch && lengths.length >= 4) {
        kind = 'box-shadow';
        indicator = parse(colorMatch[0]);
        thickness = lengths[3]!;
        reach = lengths[3]! + Math.max(0, lengths[2]!);
      }
    }
    const around = surround(inside ? element : element.parentElement);
    const seen = kind === 'none' ? around : over(indicator, around);
    const contrast = kind === 'none' ? 1 : ratio(seen, around);

    // The ring occupies the element box grown by `reach` on every side.
    const ring = { left: rect.left - reach, right: rect.right + reach, top: rect.top - reach, bottom: rect.bottom + reach };
    let clippedBy: string | null = null;
    if (kind !== 'none' && !inside) {
      for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const nodeStyle = getComputedStyle(node);
        const clips = [nodeStyle.overflowX, nodeStyle.overflowY].some((value) => value !== 'visible');
        if (!clips || node === document.body) continue;
        const box = node.getBoundingClientRect();
        const borderX = parseFloat(nodeStyle.borderLeftWidth);
        const borderY = parseFloat(nodeStyle.borderTopWidth);
        const insideBox = {
          left: box.left + borderX, right: box.right - parseFloat(nodeStyle.borderRightWidth),
          top: box.top + borderY, bottom: box.bottom - parseFloat(nodeStyle.borderBottomWidth),
        };
        const scrolls = nodeStyle.overflowX === 'auto' || nodeStyle.overflowX === 'scroll';
        const horizontalCut = nodeStyle.overflowX !== 'visible' && !scrolls && (ring.left < insideBox.left - 0.5 || ring.right > insideBox.right + 0.5);
        const verticalCut = nodeStyle.overflowY === 'hidden' && (ring.top < insideBox.top - 0.5 || ring.bottom > insideBox.bottom + 0.5);
        if (horizontalCut || verticalCut) { clippedBy = describe(node); break; }
      }
    }
    const viewportWidth = document.documentElement.clientWidth;
    return {
      element: describe(element),
      kind,
      ratio: Math.round(contrast * 100) / 100,
      thickness,
      clippedBy,
      inViewportHorizontally: ring.left >= -0.5 && ring.right <= viewportWidth + 0.5,
    };
  });
}

export interface FocusStop extends FocusMeasurement {
  index: number;
  /** Top-left of the focused element in document coordinates, to check reading order. */
  top: number;
  left: number;
  /** The stop is inside `main`, where the reading-order check applies (the navigation is fixed or sticky). */
  inMain: boolean;
}

async function activeGeometry(page: Page): Promise<{ top: number; left: number; inMain: boolean } | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.top + window.scrollY, left: rect.left + window.scrollX, inMain: Boolean(element.closest('main')) };
  });
}

/**
 * Presses Tab (or Shift+Tab) up to `limit` times, measuring each stop, until focus returns to a
 * stop already seen or leaves the page. Returns the stops in order.
 */
export async function collectFocusStops(page: Page, limit = 60, direction: 'forward' | 'backward' = 'forward'): Promise<FocusStop[]> {
  const stops: FocusStop[] = [];
  const SEEN_KEY = '__pmFocusSeen';
  await page.evaluate((key) => { (window as unknown as Record<string, unknown>)[key] = new WeakSet<Element>(); }, SEEN_KEY);
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab');
    const measurement = await measureFocus(page);
    const geometry = await activeGeometry(page);
    if (!measurement || !geometry) break;
    // A stop seen before means focus has come all the way around.
    const repeated = await page.evaluate((key) => {
      const target = window as unknown as Record<string, WeakSet<Element> | undefined>;
      const visited = target[key] ?? (target[key] = new WeakSet<Element>());
      const element = document.activeElement as Element;
      const again = visited.has(element);
      visited.add(element);
      return again;
    }, SEEN_KEY);
    if (repeated) break;
    stops.push({ ...measurement, ...geometry, index });
  }
  return stops;
}

/** The first focus stop whose indicator is missing, too faint, or cut off. */
export function focusIndicatorProblems(stops: readonly FocusStop[]): string[] {
  const problems: string[] = [];
  for (const stop of stops) {
    if (stop.kind === 'none') problems.push(`${stop.element}: no focus indicator`);
    else if (stop.ratio < MIN_COMPONENT_CONTRAST) problems.push(`${stop.element}: focus indicator contrast ${stop.ratio}:1 is below ${MIN_COMPONENT_CONTRAST}:1 (${stop.kind})`);
    if (stop.clippedBy) problems.push(`${stop.element}: focus indicator is clipped by ${stop.clippedBy}`);
    if (!stop.inViewportHorizontally) problems.push(`${stop.element}: focus indicator leaves the viewport`);
  }
  return problems;
}

/**
 * The focus stops of `main` must follow the visual order: each stop is at or below the one before it
 * (a small tolerance covers controls of different heights on one row), unless focus moves to the right, which
 * is the next control on the row or the next column.
 */
export function readingOrderProblems(stops: readonly FocusStop[], tolerancePx = 12): string[] {
  const inMain = stops.filter((stop) => stop.inMain);
  const problems: string[] = [];
  for (let index = 1; index < inMain.length; index += 1) {
    const previous = inMain[index - 1]!;
    const current = inMain[index]!;
    // Moving to the right is a new column or the next control on the same row, so its height may differ.
    const movedRight = current.left > previous.left + 40;
    if (current.top < previous.top - tolerancePx && !movedRight) {
      problems.push(`${current.element} (top ${Math.round(current.top)}) comes after ${previous.element} (top ${Math.round(previous.top)}) in the focus order`);
    }
  }
  return problems;
}

/** Moves the sequential-focus starting point to the top of the page, so the next Tab reaches the first control. */
export async function resetFocusToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    // Blurring leaves the sequential-focus starting point on the blurred element. Focusing the document body
    // (which needs a temporary tabindex) puts the starting point at the top, so the next Tab reaches the first control.
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
}

/** Presses Tab until `target` has focus. Returns how many presses it took. Throws if it is never reached. */
export async function tabTo(page: Page, target: Locator, limit = 150): Promise<number> {
  const handle = await target.first().elementHandle();
  if (!handle) throw new Error(`tabTo: ${target} is not on the page`);
  for (let presses = 0; presses <= limit; presses += 1) {
    if (await handle.evaluate((element) => element === document.activeElement)) return presses;
    await page.keyboard.press('Tab');
  }
  throw new Error(`tabTo: ${target} was not reached with ${limit} Tab presses`);
}

/** The focused element's tag and a short label, or null when focus is on the page itself. */
export async function activeElementLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) return null;
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} "${element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30)}"`;
  });
}

/** Focus must never fall back to the page itself while a person is working (WCAG 2.4.3, Requirement 12.4). */
export async function expectFocusKept(page: Page, within = 'main, nav, header, [role="dialog"]'): Promise<void> {
  const state = await page.evaluate((selector) => {
    const element = document.activeElement;
    return {
      onPage: !(element instanceof HTMLElement) || element === document.body || element === document.documentElement,
      inside: element instanceof HTMLElement ? Boolean(element.closest(selector)) : false,
    };
  }, within);
  expect(state.onPage, 'keyboard focus fell back to the page itself').toBe(false);
  expect(state.inside, 'keyboard focus left the content').toBe(true);
}

// ---- Text spacing and clipping (WCAG 1.4.12, 1.4.4, 1.4.10) ---------------------------------------------------

/** The four user overrides of WCAG 1.4.12: line height 1.5, paragraph spacing 2, letter spacing 0.12, word spacing 0.16. */
export const TEXT_SPACING_CSS = `
  *, *::before, *::after { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

export async function applyTextSpacing(page: Page): Promise<void> {
  await page.addStyleTag({ content: TEXT_SPACING_CSS });
}

/**
 * Text that a box cuts off at the bottom: an element that hides its overflow and holds more content than it
 * shows. The horizontal cases are covered by `auditLayout`. Scroll containers are not clipping, and neither is
 * a decorative bar whose child fills it.
 */
export async function auditVerticalClipping(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const issues: string[] = [];
    const describe = (element: Element) => {
      const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes.length ? `.${classes.join('.')}` : ''} "${(element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28)}"`;
    };
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (element.closest('.bg, .sr-only')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const clips = style.overflowY === 'hidden' || style.overflowY === 'clip';
      if (!clips || element.clientHeight === 0) continue;
      if (element.scrollHeight > element.clientHeight + 1 && (element.textContent ?? '').trim().length > 0) {
        issues.push(`clipped: ${describe(element)} shows ${element.clientHeight}px of ${element.scrollHeight}px`);
      }
    }
    // A control or text block with a fixed height must still hold its own text.
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('button, a, label, p, span, li, h1, h2, h3'))) {
      if (element.closest('.bg, .sr-only')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.display === 'inline') continue;
      if (element.scrollHeight > element.clientHeight + 2 && style.overflowY !== 'visible' && style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
        issues.push(`overflowing: ${describe(element)} (${element.scrollHeight}px of text in ${element.clientHeight}px)`);
      }
    }
    return Array.from(new Set(issues));
  });
}
