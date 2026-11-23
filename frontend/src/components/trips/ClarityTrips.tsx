import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../../api';
import { FALLBACK_ACTIONS, PAGE_DECISIONS, tripBalancesFallback } from '../../clarity/actionContext';
import type { FinancialSnapshot } from '../../clarity/contracts';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import { useFinancialClarity } from '../../clarity/FinancialClarityProvider';
import { useActionArrival } from '../../clarity/useActionArrival';
import { useClaritySnapshotQuery } from '../../clarity/useClaritySnapshot';
import { useHeaderAction } from '../../clarity/useHeaderAction';
import { currentMonth, inr, parseAmount } from '../../money';
import { errText, useToast } from '../../state';
import type { Trip } from '../../types';
import { ClarityPageHeader } from '../clarity/ClarityPageHeader';
import { DATA_USE_REASON_ID } from '../clarity/DataUseGate';
import { JourneyReturnLink } from '../journey/JourneyReturnLink';
import { formatMoney } from '../clarity/format';
import { RegionBoundary } from '../clarity/RegionBoundary';
import { Card, Empty, Field } from '../ui';
import { findTripOutcome, orderTripsByNearestSettlement } from './tripModel';
import './trips.css';

/** One line of server-provided balance text for a trip, or null when the snapshot has nothing for it. */
function tripStatusLine(snapshot: FinancialSnapshot | undefined, tripId: number): string | null {
  if (!snapshot) return null;
  const highlight = snapshot.highlights?.nearestTripSettlement;
  if (highlight && highlight.tripId === tripId) {
    const amount = formatMoney({ currency: 'INR', amountMinor: Math.abs(highlight.userBalance.amountMinor) });
    return highlight.label === 'receivable' ? `You are owed ${amount} (receivable)` : `You owe ${amount} (owed)`;
  }
  const outcome = findTripOutcome(snapshot, tripId);
  if (!outcome) return null;
  if (outcome.status === 'invalid_input') return 'Balances unavailable: trip data needs correction';
  if (outcome.status !== 'available' || !outcome.value) return 'Balances temporarily unavailable';
  if (outcome.value.balances.length === 0) return 'No balances yet';
  return outcome.value.balances.every((balance) => balance.label === 'settled') ? 'All settled' : 'Open balances. Open the trip to see yours.';
}

/**
 * Trips in the clarity branch. The list is ordered by the server's nearest-settlement
 * ranking (the highlighted trip, then trips named by ranked settle actions); nothing
 * is added up or compared here. Creating a trip is paused with a visible reason
 * while the data-use notice is unacknowledged.
 */
export function ClarityTrips() {
  const { toast } = useToast();
  const nav = useNavigate();
  const ids = useId();
  const gate = useDataUseGate();
  const month = currentMonth();
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [budget, setBudget] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  // Opens and focuses the new-trip form when the page was reached through the fixed "new-trip" action.
  const arrival = useActionArrival('trips');
  const rankedAction = useHeaderAction('trips');
  const query = useClaritySnapshotQuery(month);
  const view = useFinancialClarity(month);
  const snapshot = view.snapshot ?? query.data;
  const gated = !gate.financialInputsEnabled;
  useEffect(() => {
    if (arrival.action === 'new-trip') setOpen(true);
  }, [arrival.action, arrival.arrivalKey]);

  const load = useCallback(async () => {
    try {
      setTrips((await api.get<{ trips: Trip[] }>('/trips')).trips);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error);
      setTrips((current) => current ?? null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ordered = useMemo(() => orderTripsByNearestSettlement(trips ?? [], snapshot), [trips, snapshot]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || gated) return;
    const value = parseAmount(budget || '0');
    if (!name.trim()) return setFormError('Trip name is empty. Name your trip.');
    if (value === null) return setFormError('Total budget is not an accepted amount. Enter an amount such as 40000, with at most 2 decimals.');
    if (startDate && endDate && endDate < startDate) return setFormError('End date is before the start date. Pick an end date on or after the start.');
    setFormError('');
    setBusy(true);
    try {
      const response = await api.post<{ id: number }>('/trips', {
        name: name.trim(),
        destination: destination.trim(),
        budget: value,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      });
      nav(`/trips/${response.id}`);
    } catch (error) {
      toast('err', errText(error));
      setBusy(false);
    }
  }

  const firstTrip = ordered[0];
  const newTripButton = <button className="btn primary" onClick={() => setOpen(!open)}>{open ? 'Close' : '+ New trip'}</button>;
  const formErrorId = `${ids}-form-error`;

  return (
    <>
      <JourneyReturnLink />
      <ClarityPageHeader
        legacy={{ title: 'Trips & splits ✈️' }}
        title="Trips"
        decision={PAGE_DECISIONS.trips}
        action={rankedAction}
        fallbackAction={firstTrip ? tripBalancesFallback(firstTrip.id) ?? undefined : FALLBACK_ACTIONS.tripsNew}
        right={newTripButton}
      />

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
            <Card>
              <form id="new-trip-form" tabIndex={-1} onSubmit={(event) => { void create(event); }} noValidate aria-label="New trip">
                <div className="grid two tight">
                  <Field label="Trip name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Goa with the gang" maxLength={60} autoFocus aria-describedby={gated ? DATA_USE_REASON_ID : undefined} /></Field>
                  <Field label="Destination"><input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Goa" maxLength={80} /></Field>
                  <Field label="Total budget (₹)"><input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="40,000" maxLength={16} /></Field>
                  <div className="grid two tight nomargin">
                    <Field label="Start"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
                    <Field label="End"><input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} /></Field>
                  </div>
                </div>
                {formError && <p id={formErrorId} role="alert" className="clarity-field-error"><span aria-hidden="true" className="clarity-glyph">!</span>{formError}</p>}
                <button
                  className="btn primary"
                  type="submit"
                  disabled={gated}
                  aria-disabled={busy || undefined}
                  aria-describedby={gated ? DATA_USE_REASON_ID : undefined}
                >
                  {busy ? 'Creating…' : 'Create trip'}
                </button>
              </form>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <RegionBoundary
        regionKey="trip-list"
        label="Your trips"
        hasData={trips !== null}
        loading={trips === null && !loadError}
        error={trips === null ? loadError : undefined}
        onRetry={() => { void load(); }}
        minHeight={120}
      >
        {trips && trips.length === 0 ? (
          <Card><Empty emoji="🏝️" title="No trips yet" text="Create one to track the budget and split expenses with friends." /></Card>
        ) : (
          <>
          {/* Trip names are h3. This hidden h2 keeps the heading order h1, h2, h3 for assistive technology. */}
          <h2 className="sr-only">Your trips</h2>
          <ul className="grid three trip-grid" aria-label="Trips, nearest settlement first">
            {ordered.map((trip, index) => {
              const line = tripStatusLine(snapshot, trip.id);
              return (
                <motion.li key={trip.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }} style={{ listStyle: 'none' }}>
                  <Link to={`/trips/${trip.id}`} className="plain">
                    <Card tilt className="trip-card">
                      <div className="row between">
                        <h3>{trip.name}</h3>
                        <span className="pill info">{inr(trip.budget)}</span>
                      </div>
                      <p className="muted">📍 {trip.destination || 'No destination'}</p>
                      <p className="muted small">📅 {trip.start_date || '—'} → {trip.end_date || '—'}</p>
                      {line && <p className="small trip-card-status"><strong>{line}</strong></p>}
                      <span className="open-link">Open →</span>
                    </Card>
                  </Link>
                </motion.li>
              );
            })}
          </ul>
          </>
        )}
      </RegionBoundary>
    </>
  );
}
