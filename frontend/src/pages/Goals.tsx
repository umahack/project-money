import { PageTitle } from '../components/ui';
import { SavingsGoals } from '../components/SavingsGoals';

export function Goals() {
  return (
    <>
      <PageTitle
        title="Goals 🎯"
        sub="Set a target, add to it when you can, watch the bar fill. Negative contributions let you record withdrawals too."
      />
      <SavingsGoals />
    </>
  );
}
