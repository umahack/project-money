import { useState } from 'react';
import { api } from '../api';
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
      const token = sessionStorage.getItem('pm_token') ?? '';
      const res = await fetch(`${base}/api/finance/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-money-expenses-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('ok', 'Downloaded');
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
