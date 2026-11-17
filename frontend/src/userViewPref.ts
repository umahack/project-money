/**
 * Session-scoped flag that remembers whether an admin has explicitly asked
 * for the user-side view. Kept in a tiny module so the Shell and the Private
 * route gate in App.tsx can both import it without creating a Shell↔App cycle.
 */
const KEY = 'pm_prefer_user_view';

export function markUserViewPreferred(): void {
  try { sessionStorage.setItem(KEY, '1'); } catch { /* ignore */ }
}
export function clearUserViewPreference(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
export function wantsUserView(): boolean {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}
