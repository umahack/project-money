import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card, PageTitle } from '../components/ui';
import { SpendingTracker } from '../components/SpendingTracker';
import { MonthlyHistoryChart } from '../components/MonthlyHistoryChart';
import { SmartInsights } from '../components/SmartInsights';
import { errText, useToast } from '../state';
import type { Plan } from '../types';

export function Spending() {
  const { toast } = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setPlan(await api.get<Plan>('/finance/plan'));
    } catch (e) {
      toast('err', errText(e));
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  if (!plan) {
    return (
      <>
        <PageTitle title="Spending 📊" sub="Pulling this month's log…" />
        <Card><div style={{ height: 20, width: 240, background: 'rgba(0,0,0,0.07)', borderRadius: 6, marginBottom: 10 }} /><div style={{ height: 14, width: 180, background: 'rgba(0,0,0,0.05)', borderRadius: 6 }} /></Card>
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Spending 📊"
        sub="Daily log, inline category budgets, and a 12-month history chart. Everything comes from your logged entries."
      />
      <SpendingTracker disposable={plan.afterFixed} onChange={() => setReloadKey((k) => k + 1)} />
      <SmartInsights refreshKey={reloadKey} />
      <MonthlyHistoryChart refreshKey={reloadKey} />
    </>
  );
}
