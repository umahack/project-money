import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Token-level contrast for the clarity pages in both themes (task 17.4, Requirements 12.11 to 12.13).
 *
 * The browser acceptance specs measure real elements. This test pins the design tokens they come from, so a
 * token edit that breaks a ratio fails in the fast unit run: 4.5:1 for normal text, 3:1 for large text, status
 * glyphs, field edges, focus rings, and chart fills. It reads the real stylesheets, so it cannot drift from them.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const clarity = readFileSync(resolve(SRC, 'components/clarity/clarity.css'), 'utf8');

type Rgba = [number, number, number, number];

/** The custom properties of every rule with exactly this selector, later rules winning. */
function block(source: string, selector: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  let found = false;
  for (let start = source.indexOf(`${selector} {`); start >= 0; start = source.indexOf(`${selector} {`, start + 1)) {
    // Only a rule that starts a line counts, so `x:root {` or a longer selector is not matched.
    if (start > 0 && source[start - 1] !== '\n') continue;
    found = true;
    const end = source.indexOf('}', start);
    for (const match of source.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[match[1]!] = match[2]!.trim();
  }
  if (!found) throw new Error(`No rule for ${selector}`);
  return tokens;
}

/** Custom properties as the cascade resolves them for each theme on a page that renders `main.clarity-on`. */
const dark = {
  ...block(stylesheet, ':root'),
  ...block(clarity, ':root'),
  ...block(clarity, ":root:not([data-theme='light']):has(main.clarity-on)"),
};
const light = {
  ...block(stylesheet, ':root'),
  ...block(stylesheet, ":root[data-theme='light']"),
  ...block(clarity, ':root'),
  ...block(clarity, ":root[data-theme='light']"),
  ...block(clarity, ":root[data-theme='light']:has(main.clarity-on)"),
};
const THEMES = { light, dark } as const;

function parse(value: string, tokens: Record<string, string>): Rgba {
  const trimmed = value.trim();
  const reference = trimmed.match(/^var\((--[\w-]+)\)$/);
  if (reference) return parse(tokens[reference[1]!]!, tokens);
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)).concat(1) as Rgba;
  }
  const rgb = trimmed.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const [r, g, b, a] = rgb[1]!.split(',').map((part) => parseFloat(part));
    return [r!, g!, b!, a ?? 1];
  }
  throw new Error(`Cannot read the colour "${value}"`);
}
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const alpha = top[3] + bottom[3] * (1 - top[3]);
  const mix = (a: number, b: number) => (a * top[3] + b * bottom[3] * (1 - top[3])) / alpha;
  return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), alpha];
};
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colours text sits on: the page, the card (translucent in dark, over the page), and a tinted chip or tab. */
function surfaces(theme: 'light' | 'dark'): Record<string, Rgba> {
  const tokens = THEMES[theme];
  const page = parse('var(--bg)', tokens);
  const pageAlt = parse('var(--bg-2)', tokens);
  // The dark page also carries colour blobs; the strongest one (#6a3dff at 50 percent) is the worst case.
  const blob: Rgba = over([0x6a, 0x3d, 0xff, 0.5], page);
  const card = over(parse('var(--glass)', tokens), page);
  const cardOnBlob = over(parse('var(--glass)', tokens), blob);
  const chip = over(parse('var(--border)', tokens), card);
  const tab = theme === 'light' ? parse('#f3f0eb', tokens) : over(parse('var(--border)', tokens), card);
  return { page, pageAlt, card, cardOnBlob, chip, tab };
}

function expectRatio(label: string, foreground: Rgba, background: Rgba, minimum: number): void {
  const value = ratio(over(foreground, background), background);
  expect(value, `${label}: ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
}

describe.each(['light', 'dark'] as const)('clarity tokens, %s theme', (theme) => {
  const tokens = THEMES[theme];
  const surface = surfaces(theme);
  const color = (name: string) => parse(`var(${name})`, tokens);

  it('keeps normal text at 4.5:1 or more on every surface', () => {
    for (const [name, background] of Object.entries(surface)) {
      expectRatio(`--text on ${name}`, color('--text'), background, 4.5);
      expectRatio(`--muted on ${name}`, color('--muted'), background, 4.5);
      expectRatio(`--accent (links and accent text) on ${name}`, color('--accent'), background, 4.5);
      expectRatio(`--danger on ${name}`, color('--danger'), background, 4.5);
    }
  });

  it('keeps status tones (text, glyph, and badge border) at 4.5:1 on the page and the card', () => {
    for (const tone of ['--clarity-ok', '--clarity-info', '--clarity-warn', '--clarity-danger']) {
      for (const name of ['page', 'card', 'cardOnBlob'] as const) expectRatio(`${tone} on ${name}`, color(tone), surface[name]!, 4.5);
    }
  });

  it('keeps the focus ring at 3:1 against the page, the card, and the tab fill', () => {
    for (const name of ['page', 'pageAlt', 'card', 'cardOnBlob', 'tab'] as const) {
      expectRatio(`--clarity-focus on ${name}`, color('--clarity-focus'), surface[name]!, 3);
      expectRatio(`--accent (global focus ring) on ${name}`, color('--accent'), surface[name]!, 3);
    }
  });

  it('gives text fields an edge of 3:1 against the card', () => {
    expectRatio('--field-border on card', color('--field-border'), surface.card!, 3);
    expectRatio('--field-border on page', color('--field-border'), surface.page!, 3);
  });

  it('keeps category and chart colours at 3:1 against the bar track so a bar is visible', () => {
    const track = surface.chip!;
    for (const name of ['--c-fixed', '--c-save', '--c-need', '--c-want']) expectRatio(`${name} bar on the track`, color(name), track, 3);
  });
});

describe('button fills', () => {
  it('keeps white text at 4.5:1 at every stop of the dark primary gradient and the danger fill', () => {
    const white: Rgba = [255, 255, 255, 1];
    const gradient = clarity.match(/:root:not\(\[data-theme='light'\]\):has\(main\.clarity-on\) \.btn\.primary,[\s\S]*?linear-gradient\(135deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\)/i);
    expect(gradient, 'the dark primary gradient is defined for clarity pages').not.toBeNull();
    for (const stop of [gradient![1]!, gradient![2]!]) expectRatio(`white on ${stop}`, white, parse(stop, {}), 4.5);
    const danger = clarity.match(/main\.clarity-on \.btn\.danger-solid \{ background: linear-gradient\(135deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\)/i);
    expect(danger, 'the danger fill is defined for clarity pages').not.toBeNull();
    for (const stop of [danger![1]!, danger![2]!]) expectRatio(`white on ${stop}`, white, parse(stop, {}), 4.5);
  });

  it('keeps the light primary button (cream on charcoal) and the selected segment (white on teal) at 4.5:1', () => {
    expectRatio('cream on charcoal', parse('#faf7f2', {}), parse('#1a1a1a', {}), 4.5);
    expectRatio('white on --primary', [255, 255, 255, 1], parse('var(--primary)', light), 4.5);
  });
});
