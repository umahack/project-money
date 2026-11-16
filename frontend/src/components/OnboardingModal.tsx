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
    title: 'Hey, welcome in',
    body: "I'll help you figure out where your money should go each month. Takes 60 seconds to set up.",
  },
  {
    emoji: '💰',
    title: 'Step 1 — Your monthly pay',
    body: 'How much actually lands in your bank each month? Just the take-home number. No tax math needed.',
  },
  {
    emoji: '📄',
    title: 'Step 2 — Your monthly bills',
    body: "Rent, Netflix, insurance, loan EMIs — anything that leaves your account on its own. Add them once, they stay saved.",
  },
  {
    emoji: '✨',
    title: "That's it",
    body: "You'll see what's left, how much is safe to spend each day, and where to save. Log daily buys as they happen (or don't — it still works).",
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
