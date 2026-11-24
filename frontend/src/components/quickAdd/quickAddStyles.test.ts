import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Style contracts for the Quick Add shell and the input label (task 16.1, Requirements 1.3, 12.7, 12.9, 12.12).
 * jsdom does not apply a stylesheet, so these read the real files, as the other style tests do.
 */
const shell = readFileSync('src/components/quickAdd/quickAddShell.css', 'utf8');
const input = readFileSync('src/components/quickAdd/quickAdd.css', 'utf8');
const app = readFileSync('src/styles.css', 'utf8');
const clarity = readFileSync('src/components/clarity/clarity.css', 'utf8');

function token(source: string, selector: string, name: string): string {
  const start = source.indexOf(`\n${selector} {`);
  const end = source.indexOf('}', start);
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(source.slice(start, end));
  if (!match) throw new Error(`${name} is not set in ${selector}`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('Quick Add shell styles', () => {
  it('draws the floating action from theme tokens at 4.5:1 for its text and 3:1 against the page, in both themes', () => {
    expect(shell).toMatch(/\.qa-fab \{[^}]*background: var\(--clarity-info\); color: var\(--bg\)/);
    const themes = {
      dark: [token(app, ':root', '--bg'), token(clarity, ':root', '--clarity-info')],
      light: [token(app, ":root[data-theme='light']", '--bg'), token(clarity, ":root[data-theme='light']", '--clarity-info')],
    } as const;
    for (const [bg, fill] of Object.values(themes)) {
      expect(contrast(fill, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the floating action at least 48 by 48 and the dialog controls at 44 by 44', () => {
    expect(shell).toMatch(/\.qa-fab \{[^}]*min-width: 48px; min-height: 48px/);
    expect(shell).toMatch(/\.qa-dialog-body \.btn \{ min-height: 44px; min-width: 44px; \}/);
    expect(shell).toMatch(/\.qa-dialog-body :is\(input, select\) \{ min-height: 44px;/);
  });

  it('lets the shortcut hint wrap, so 200 percent text at 320 pixels does not scroll sideways', () => {
    const rule = /\.qa-shortcut-hint \{([^}]*)\}/.exec(shell)?.[1] ?? '';
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow-wrap: anywhere/);
  });

  it('keeps the input label at body size over the tile label rule that styles.css shrinks under 520 pixels', () => {
    expect(app).toMatch(/@media \(max-width: 520px\) \{[\s\S]*\.qa-label \{ font-size: 0\.72rem; \}/);
    expect(input).toMatch(/\.qa-input \.qa-label \{ font-size: 1rem;/);
  });
});
