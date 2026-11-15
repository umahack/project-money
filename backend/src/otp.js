// Shared helpers for 6-digit OTP flows (sign-up email verification + alias email linking).
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_VERIFY_ATTEMPTS = 6;
export const HANDLE_RE = /^[a-z0-9._-]{3,30}$/;

export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function hashCode(code) {
  return bcrypt.hash(code, 10);
}

export async function matches(code, hash) {
  return bcrypt.compare(code, hash);
}

export function expiresAt(ms = CODE_TTL_MS) {
  return new Date(Date.now() + ms).toISOString();
}

export function isExpired(iso) {
  return !iso || new Date(iso).getTime() < Date.now();
}

export function normalizeHandle(input) {
  const h = String(input || '').trim().toLowerCase();
  if (!h) return { value: null };
  if (!HANDLE_RE.test(h))
    return { error: 'Nickname must be 3–30 chars: letters, digits, dot, underscore, or dash.' };
  return { value: h };
}
