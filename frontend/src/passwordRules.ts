/**
 * Single source of truth for password strength UI across every entry point:
 * register, change-password, and reset-password. Keeps copy and checks in sync.
 */
export interface PwRule {
  key: string;
  label: string;
  test: (p: string) => boolean;
}

export const PW_RULES: PwRule[] = [
  { key: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { key: 'letter', label: 'Contains a letter', test: (p) => /[A-Za-z]/.test(p) },
  { key: 'number', label: 'Contains a number', test: (p) => /\d/.test(p) },
  { key: 'space', label: 'No leading or trailing spaces', test: (p) => p.length > 0 && p === p.trim() },
];

export function pwChecks(password: string): Array<PwRule & { ok: boolean }> {
  return PW_RULES.map((r) => ({ ...r, ok: r.test(password) }));
}

export function pwMissingLabels(password: string): string[] {
  return pwChecks(password).filter((c) => !c.ok).map((c) => c.label.toLowerCase());
}
