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
    emoji: '🎯',
    title: "Here's the point",
    body: "Most of us earn fine but still end the month wondering where it went. This app tells you — upfront — how much you can spend each day and how much you'll actually save. No spreadsheets.",
  },
  {
    emoji: '📊',
    title: 'What you get',
    body: 'A clear number for daily spend, a split of Needs / Wants / Save, and a live view of what you\'ve used so far. Updates every time you log an expense.',
  },
  {
    emoji: '🔒',
    title: "Your data stays yours",
    body: "Only you can see it. No ads, no selling data, no sharing with banks. Export or delete your account anytime from Settings.",
  },
  {
    emoji: '⏱️',
    title: 'Setup takes 60 seconds',
    body: "Just your monthly take-home pay. Bills (rent, Netflix, EMIs) are optional — you can add them later. Daily expenses are optional too; the plan works either way.",
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
                  {last ? "Let's go 🚀" : 'Next →'}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
