import { toPaise } from '../../money';
import type { TripDetailData } from '../../types';
import { Card, Money, ProgressBar } from '../ui';
import { isSettlementPayment } from './tripModel';

/**
 * Name, dates, and budget for a trip. "Spent" adds up the entered shared-expense
 * amounts only (settlement payments are left out). It is a plain total of what was
 * entered, not an allocation or a balance, and does not depend on the split.
 */
export function TripSummary({ d }: { d: TripDetailData }) {
  const spentMinor = d.expenses
    .filter((expense) => !isSettlementPayment(expense.description))
    .reduce((sum, expense) => sum + toPaise(expense.amount), 0);
  const spent = spentMinor / 100;
  const left = d.trip.budget - spent;
  return (
    <Card tilt className="trip-header">
      <div className="row between wrap">
        <div>
          <h2>{d.trip.name}</h2>
          <p className="muted">📍 {d.trip.destination || 'No destination'} · 📅 {d.trip.start_date || '—'} → {d.trip.end_date || '—'}</p>
        </div>
      </div>
      <div className="stat-row">
        <div><span className="muted">Spent</span><Money value={spent} className="big" /></div>
        <div><span className="muted">Budget</span><Money value={d.trip.budget} className="big" /></div>
        <div><span className="muted">{left >= 0 ? 'Remaining' : 'Over budget'}</span><Money value={Math.abs(left)} className={`big ${left < 0 ? 'neg' : 'accent'}`} /></div>
      </div>
      {d.trip.budget > 0 && <ProgressBar value={spent} max={d.trip.budget} label="Share of the trip budget spent" />}
    </Card>
  );
}
