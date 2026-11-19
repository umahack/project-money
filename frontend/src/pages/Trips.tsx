import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api';
import { Card, Empty, Field, PageTitle } from '../components/ui';
import { inr, parseAmount } from '../money';
import { errText, useToast } from '../state';
import type { Trip } from '../types';

export function Trips() {
  const { toast } = useToast();
  const nav = useNavigate();
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [budget, setBudget] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTrips((await api.get<{ trips: Trip[] }>('/trips')).trips);
    } catch (e) {
      toast('err', errText(e));
      setTrips([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const value = parseAmount(budget || '0');
    if (!name.trim()) return toast('err', 'Name your trip');
    if (value === null) return toast('err', 'Enter a valid budget');
    if (startDate && endDate && endDate < startDate) return toast('err', 'The end date is before the start date');
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>('/trips', {
        name: name.trim(),
        destination: destination.trim(),
        budget: value,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      });
      nav(`/trips/${r.id}`);
    } catch (err) {
      toast('err', errText(err));
      setBusy(false);
    }
  }

  if (!trips) {
    return (
      <>
        <PageTitle title="Trips ✈️" sub="Loading your trips…" />
        <Card><div style={{ height: 18, width: 260, background: 'rgba(0,0,0,0.06)', borderRadius: 6, marginBottom: 10 }} /><div style={{ height: 14, width: 200, background: 'rgba(0,0,0,0.05)', borderRadius: 6 }} /></Card>
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Trips & splits ✈️"
        sub="Plan a trip budget, add your crew, and split costs like Splitwise."
        right={<button className="btn primary" onClick={() => setOpen(!open)}>{open ? 'Close' : '+ New trip'}</button>}
      />

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
            <Card>
              <form onSubmit={create}>
                <div className="grid two tight">
                  <Field label="Trip name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Goa with the gang" maxLength={60} autoFocus /></Field>
                  <Field label="Destination"><input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Goa" maxLength={80} /></Field>
                  <Field label="Total budget (₹)"><input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="40,000" maxLength={16} /></Field>
                  <div className="grid two tight nomargin">
                    <Field label="Start"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
                    <Field label="End"><input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} /></Field>
                  </div>
                </div>
                <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create trip'}</button>
              </form>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {trips.length === 0 ? (
        <Card><Empty emoji="🏝️" title="No trips yet" text="Create one to track the budget and split expenses with friends." /></Card>
      ) : (
        <div className="grid three">
          {trips.map((t, idx) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }}>
              <Link to={`/trips/${t.id}`} className="plain">
                <Card tilt className="trip-card">
                  <div className="row between">
                    <h3>{t.name}</h3>
                    <span className="pill info">{inr(t.budget)}</span>
                  </div>
                  <p className="muted">📍 {t.destination || 'No destination'}</p>
                  <p className="muted small">📅 {t.start_date || '—'} → {t.end_date || '—'}</p>
                  <span className="open-link">Open →</span>
                </Card>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </>
  );
}
