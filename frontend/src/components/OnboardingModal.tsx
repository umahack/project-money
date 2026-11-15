import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../state';

const STORAGE_KEY = 'pm_onboarded_v1';

interface Step {
  emoji: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    emoji: '👋',
    title: 'Welcome to Project Money',
    body: 'A simple home for your salary, spending, and shared trips. Nothing you enter leaves your account.',
  },
  {
    emoji: '💰',
    title: 'Enter your monthly salary',
    body: 'On the Home page, type the amount that credits each month. We assume it stays the same unless you update it.',
  },
  {
    emoji: '🏦',
    title: 'Add your fixed payments',
    body: 'Rent, EMIs, insurance, subscriptions. Everything that leaves your account automatically.',
  },
  {
    emoji: '📊',
    title: 'The rest is your money plan',
    body: 'What is left after fixed payments is split 50% needs / 30% wants / 20% save. Log daily expenses so you see how you are tracking.',
  },
  {
    emoji: '✈️',
    title: 'Go on trips, split fairly',
    body: 'Create a trip, invite friends by email, add shared expenses. We work out who owes whom.',
  },
];

export function OnboardingModal() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!user) return;
    try {
      if (localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      return;
    }
    setOpen(true);
    setStep(0);
  }, [user]);

  function dismiss() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
    setOpen(false);
  }

  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={dismiss}
        >
          <motion.div
            className="modal"
            initial={{ y: 24, scale: 0.95, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 12, scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onb-title"
          >
            <div className="onb-dots" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
              {STEPS.map((_, i) => <span key={i} className={`onb-dot ${i === step ? 'on' : i < step ? 'done' : ''}`} />)}
            </div>
            <div className="onb-emoji" aria-hidden="true">{current.emoji}</div>
            <h2 id="onb-title" style={{ marginBottom: '0.3rem' }}>{current.title}</h2>
            <p className="muted" style={{ marginTop: 0 }}>{current.body}</p>
            <div className="row-sm" style={{ gap: '0.5rem', justifyContent: 'space-between', marginTop: '1rem' }}>
              <button className="btn ghost sm" onClick={dismiss}>Skip tour</button>
              <div className="row-sm" style={{ gap: '0.5rem' }}>
                {step > 0 && (
                  <button className="btn ghost sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>← Back</button>
                )}
                <button className="btn primary sm" onClick={() => (last ? dismiss() : setStep((s) => s + 1))}>
                  {last ? "Let's go" : 'Next →'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
