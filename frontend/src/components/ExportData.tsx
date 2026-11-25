import { useState } from 'react';
import { clearAuth } from '../api';
import { getToken } from '../tokenStore';
import { saveAndShare } from '../native/exportFile';
import { Card } from './ui';
import { errText, useToast } from '../state';

export function ExportData() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      // Build the same URL the api client would build, but we need the raw blob response.
      const base = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
      const token = getToken() ?? '';
      const res = await fetch(`${base}/api/finance/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        clearAuth();
        window.dispatchEvent(new CustomEvent('auth:expired', { detail: 'Your session has ended. Please sign in again.' }));
        return;
      }
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const result = await saveAndShare(blob, `project-money-expenses-${stamp}.csv`);
      if (result.outcome === 'failed') throw new Error('Could not save the export');
      if (result.outcome === 'cancelled') return;
      toast('ok', result.outcome === 'shared' ? 'Shared' : 'Downloaded');
    } catch (err) {
      toast('err', errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2>📤 Export my data</h2>
      <p className="muted small">Download every expense you've logged as a CSV. Opens in Excel, Numbers, or Google Sheets.</p>
      <button className="btn ghost" onClick={() => void download()} disabled={busy}>
        {busy ? 'Preparing…' : 'Download expenses (.csv)'}
      </button>
    </Card>
  );
}
