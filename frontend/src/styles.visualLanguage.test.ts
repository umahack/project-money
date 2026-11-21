import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The clarity work keeps the product's warm visual language (Requirement 12.1): the cream-and-charcoal palette,
 * the three typefaces, and the rounded forms. Task 17.4 changed some colour tokens to meet contrast ratios and had to
 * do it "without changing the warm visual language". This pins that promise to the real stylesheets, so a later
 * contrast fix cannot quietly turn the palette cold or square the corners.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const clarity = readFileSync(resolve(SRC, 'components/clarity/clarity.css'), 'utf8');
const entry = readFileSync(resolve(SRC, 'main.tsx'), 'utf8');

function tokens(source: string, selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (let start = source.indexOf(`${selector} {`); start >= 0; start = source.indexOf(`${selector} {`, start + 1)) {
    if (start > 0 && source[start - 1] !== '\n') continue;
    const end = source.indexOf('}', start);
    for (const match of source.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) found[match[1]!] = match[2]!.trim();
  }
  return found;
}

function rgbOf(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) throw new Error(`Expected a six-digit hex colour, received ${value}`);
  return [0, 2, 4].map((offset) => parseInt(hex[1]!.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** Hue in degrees, and saturation from 0 to 1. */
function hsl([r, g, b]: [number, number, number]): { hue: number; saturation: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation };
}

const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

const base = tokens(stylesheet, ':root');
const light = { ...base, ...tokens(stylesheet, ":root[data-theme='light']") };

describe('warm visual language (Requirement 12.1)', () => {
  it('keeps the cream paper, charcoal text, and emerald accent of the light theme', () => {
    expect(light['--bg']).toBe('#faf7f2');
    expect(light['--bg-2']).toBe('#f4efe6');
    expect(light['--text']).toBe('#1a1a1a');
    expect(light['--glass']).toBe('#ffffff');
    expect(light['--primary']).toBe('#0f766e');
    expect(light['--accent']).toBe('#10b981');
    // Warm: the cream surfaces lean toward red and yellow, never toward blue.
    for (const token of ['--bg', '--bg-2'] as const) {
      const [r, g, b] = rgbOf(light[token]!);
      expect(r, `${token} red channel`).toBeGreaterThanOrEqual(g);
      expect(g, `${token} green channel`).toBeGreaterThan(b);
    }
  });

  it('keeps the rounded forms and the three typefaces', () => {
    expect(parseInt(base['--radius']!, 10)).toBeGreaterThanOrEqual(16);
    expect(base['--font']).toMatch(/^'Outfit Variable'/);
    expect(base['--mono']).toMatch(/^'JetBrains Mono Variable'/);
    expect(light['--serif']).toMatch(/^'Fraunces Variable'/);
    for (const font of ['outfit', 'jetbrains-mono', 'fraunces']) {
      expect(entry).toContain(`@fontsource-variable/${font}`);
    }
    // Headings stay serif in the warm theme, and cards keep the shared radius.
    expect(stylesheet).toMatch(/:root\[data-theme='light'\] h1 \{[^}]*font-family: var\(--serif\)/);
    expect(stylesheet).toMatch(/\.card \{[^}]*border-radius: var\(--radius\)/);
  });

  it('lets the clarity styles adjust contrast without redefining the palette, typefaces, or radius', () => {
    const owned = new Set(['--bg', '--bg-2', '--glass', '--glass-strong', '--text', '--primary', '--primary-2', '--font', '--mono', '--serif', '--radius']);
    const overrides = [
      tokens(clarity, ':root'),
      tokens(clarity, ":root[data-theme='light']"),
      tokens(clarity, ":root[data-theme='light']:has(main.clarity-on)"),
      tokens(clarity, ":root:not([data-theme='light']):has(main.clarity-on)"),
    ];
    for (const set of overrides) {
      for (const token of Object.keys(set)) expect(owned.has(token), `${token} is redefined by the clarity styles`).toBe(false);
    }
  });

  it('keeps every contrast-adjusted colour in the hue family it started in', () => {
    const adjusted = {
      ...tokens(clarity, ":root[data-theme='light']:has(main.clarity-on)"),
    };
    let compared = 0;
    for (const [token, value] of Object.entries(adjusted)) {
      const original = light[token];
      if (!original || !/^#[0-9a-f]{6}$/i.test(original) || !/^#[0-9a-f]{6}$/i.test(value)) continue;
      const from = hsl(rgbOf(original));
      const to = hsl(rgbOf(value));
      // Greys have no hue to keep.
      if (from.saturation < 0.15 || to.saturation < 0.15) continue;
      compared += 1;
      expect(hueDistance(from.hue, to.hue), `${token} moved from ${original} to ${value}`).toBeLessThanOrEqual(20);
    }
    // Accent, the three category colours, and the danger colour are all adjusted today.
    expect(compared).toBeGreaterThanOrEqual(4);
  });
});
