import { PageTitle } from '../components/ui';
import { RecurringExpenses } from '../components/RecurringExpenses';

export function Recurring() {
  return (
    <>
      <PageTitle
        title="Recurring 🔁"
        sub="Netflix, rent, gym, SIPs — anything that charges on a predictable day. We log them for you so your plan always reflects reality."
      />
      <RecurringExpenses />
    </>
  );
}
