import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { PageTitle, Spinner } from '../components/ui';
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

  if (!plan) return <Spinner />;

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
