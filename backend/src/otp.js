// Shared helpers for 6-digit OTP flows used by signup and email-change.
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

export const CODE_TTL_MS = 15 * 60 * 1000;      // 15-min window
export const MAX_VERIFY_ATTEMPTS = 6;            // then force a resend

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
