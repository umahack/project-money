import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card } from './ui';
import { selectFinancialClarityRollout } from '../clarity/rollout';
import { errText, useToast } from '../state';
import { ClarityTripShare } from './trips/ClarityTripShare';

interface ShareState {
  enabled: boolean;
  token: string | null;
}

/**
 * Public share link card. With `VITE_FINANCIAL_CLARITY_ENABLED` on, creating or
 * replacing a link first shows the exact public fields and needs a confirmation.
 * With it off this is the original card, unchanged.
 */
export function TripShareLink({ tripId }: { tripId: number }) {
  return selectFinancialClarityRollout().enabled
    ? <ClarityTripShare tripId={tripId} />
    : <LegacyTripShareLink tripId={tripId} />;
}

function LegacyTripShareLink({ tripId }: { tripId: number }) {
  const { toast } = useToast();
  const [state, setState] = useState<ShareState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.get<ShareState>(`/trips/${tripId}/share`));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [tripId, toast]);

  useEffect(() => { void load(); }, [load]);

  const url = state?.token ? `${window.location.origin}/share/trip/${state.token}` : '';

  async function enable() {
    setBusy(true);
    try {
      await api.post(`/trips/${tripId}/share`, {});
      await load();
      toast('ok', 'Share link enabled');
    } catch (e) { toast('err', errText(e)); }
    finally { setBusy(false); }
  }

  async function disable() {
    if (!confirm('Disable the share link? The current link stops working immediately.')) return;
    setBusy(true);
    try {
      await api.del(`/trips/${tripId}/share`);
      await load();
      toast('ok', 'Share link disabled');
    } catch (e) { toast('err', errText(e)); }
    finally { setBusy(false); }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast('ok', 'Link copied');
    } catch { toast('err', 'Could not copy — long-press the link to copy manually'); }
  }

  if (!state) return null;

  return (
    <Card>
      <h2>🔗 Public share link</h2>
      <p className="muted small">
        Anyone with this link can view the trip (members and settle-up), without signing in. Nothing can
        be changed through the link — read-only.
      </p>
      {state.enabled && url ? (
        <div className="stack-sm">
          <input value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
          <div className="row-sm" style={{ gap: '0.5rem' }}>
            <button className="btn sm" onClick={() => void copy()}>Copy link</button>
            <button className="btn sm ghost" onClick={() => void enable()} disabled={busy}>Rotate</button>
            <button className="btn sm ghost danger" onClick={() => void disable()} disabled={busy}>Disable</button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => void enable()} disabled={busy}>
          {busy ? 'Creating…' : 'Create public link'}
        </button>
      )}
    </Card>
  );
}
