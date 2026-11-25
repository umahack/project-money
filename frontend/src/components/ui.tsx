import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from 'framer-motion';
import { inr } from '../money';
import { popOverlay, pushOverlay } from '../native/backButton';

/** Glass card with a cursor-following spotlight and a gentle 3D tilt on hover. */
export function Card({ children, className = '', tilt = false, ...rest }: HTMLAttributes<HTMLDivElement> & { tilt?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    el.style.setProperty('--mx', `${x}px`);
    el.style.setProperty('--my', `${y}px`);
    if (tilt) {
      el.style.setProperty('--rx', `${((y / r.height) * 2 - 1) * -4}deg`);
      el.style.setProperty('--ry', `${((x / r.width) * 2 - 1) * 5}deg`);
    }
  };
  const onLeave = () => {
    ref.current?.style.setProperty('--rx', '0deg');
    ref.current?.style.setProperty('--ry', '0deg');
  };
  return (
    <div ref={ref} className={`card ${tilt ? 'tilt' : ''} ${className}`} onPointerMove={onMove} onPointerLeave={onLeave} {...rest}>
      {children}
    </div>
  );
}

/** Rupee amount that counts up/down smoothly whenever the value changes. */
export function Money({ value, className = '' }: { value: number; className?: string }) {
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 90, damping: 20 });
  const [shown, setShown] = useState(value);
  useEffect(() => {
    mv.set(value);
  }, [value, mv]);
  useEffect(() => spring.on('change', (v) => setShown(v)), [spring]);
  return <span className={`mono ${className}`}>{inr(Math.abs(shown - value) < 0.5 ? value : Math.round(shown))}</span>;
}

export function PageTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

/** Loading spinner. The free host sleeps when idle, so say so if the wait is long. */
export function Spinner() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="spinner-wrap" aria-label="Loading">
      <div className="spinner" />
      {slow && <p className="muted small center">Waking the server up. The free host can take about 30 seconds after being idle.</p>}
    </div>
  );
}

/** Shimmer placeholder for a loading block. Width/height are flex-friendly. */
export function Skeleton({ w = '100%', h = 14, radius = 6, style }: { w?: number | string; h?: number | string; radius?: number; style?: React.CSSProperties }) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: typeof w === 'number' ? `${w}px` : w,
        height: typeof h === 'number' ? `${h}px` : h,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

export function Empty({ emoji, title, text }: { emoji: string; title: string; text?: string }) {
  return (
    <div className="empty">
      <motion.div className="empty-emoji" animate={{ y: [0, -8, 0] }} transition={{ repeat: Infinity, duration: 2.4 }}>
        {emoji}
      </motion.div>
      <strong>{title}</strong>
      {text && <p className="muted">{text}</p>}
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const over = max > 0 && value > max;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <motion.div className={`progress-fill ${over ? 'over' : ''}`} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.9, ease: 'easeOut' }} />
    </div>
  );
}

/** Donut chart built with SVG; segments grow in via a CSS transition. */
export function Donut({ segments, centerTop, centerBottom }: { segments: Array<{ label: string; value: number; color: string }>; centerTop: string; centerBottom: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 60);
    return () => clearTimeout(t);
  }, []);
  const total = segments.reduce((s, x) => s + x.value, 0);
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 120 120" role="img" aria-label="Salary split chart">
        <circle cx="60" cy="60" r="46" className="donut-track" />
        {total > 0 &&
          segments.map((s) => {
            const len = (s.value / total) * 100;
            const shown = Math.max(len - 0.8, 0);
            const el = (
              <circle
                key={s.label}
                cx="60"
                cy="60"
                r="46"
                pathLength={100}
                className="donut-seg"
                stroke={s.color}
                strokeDasharray={ready ? `${shown} ${100 - shown}` : '0 100'}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="donut-center">
        <span className="muted">{centerTop}</span>
        <strong className="mono">{centerBottom}</strong>
      </div>
    </div>
  );
}

/** Tiny coin-burst celebration, purely decorative. */
export function burst(x: number, y: number): void {
  const n = 14;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'burst-coin';
    el.textContent = i % 3 === 0 ? '₹' : '🪙';
    const ang = (Math.PI * 2 * i) / n;
    const dist = 60 + Math.random() * 80;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    el.style.setProperty('--dy', `${Math.sin(ang) * dist - 30}px`);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }
}

const MODAL_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Accessible modal: Esc and backdrop close it (unless `locked`), focus moves into it and stays in it, scroll is frozen. */
export function Modal({ open, onClose, children, title, locked = false }: { open: boolean; onClose: () => void; children: ReactNode; title: string; locked?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // CSS cannot stop Framer Motion, which writes the transform inline. With reduced motion the box only fades, so nothing
  // scales or slides (Requirement 12.10 of Quick Add, which opens in this dialog).
  const reduceMotion = useReducedMotion();
  // While open, every Modal is an entry in the back-button overlay registry (a no-op on the web, where nothing reads it),
  // so the hardware back button closes the top modal, or does nothing while it is `locked`, before any navigation.
  // `onClose` is read through a ref so a caller that passes a new function each render does not re-register the entry
  // and change its place in the stack. It is the same function Escape and the backdrop call.
  const overlayId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    return () => popOverlay(overlayId);
  }, [open, overlayId]);
  useEffect(() => {
    if (!open) return;
    // An entry with the same id replaces the old one in place, so a change of `locked` keeps the stack order.
    pushOverlay({ id: overlayId, closable: !locked, onClose: () => onCloseRef.current() });
  }, [open, locked, overlayId]);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) onClose();
      // aria-modal promises that the page behind is out of reach, so Tab and Shift+Tab wrap inside the dialog.
      if (e.key !== 'Tab' || !box.current) return;
      const dialog = box.current;
      const stops = Array.from(dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE));
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const outside = !active || !dialog.contains(active);
      if (e.shiftKey && (outside || active === dialog || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose, locked]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
          <motion.div
            ref={box}
            tabIndex={-1}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={reduceMotion ? { opacity: 0 } : { scale: 0.92, y: 24, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { scale: 1, y: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { scale: 0.96, y: 16, opacity: 0 }}
            transition={reduceMotion ? { duration: 0.12 } : { type: 'spring', stiffness: 300, damping: 26 }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface ConfirmState {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

/** Replaces window.confirm with a themed dialog. */
export function ConfirmDialog({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const last = useRef<ConfirmState | null>(null);
  if (state) last.current = state;
  const s = state ?? last.current;
  return (
    <Modal open={!!state} onClose={onClose} title={s?.title ?? 'Confirm'}>
      <h2>{s?.title}</h2>
      <p className="muted">{s?.text}</p>
      <div className="row end">
        <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className={`btn ${s?.danger ? 'danger-solid' : 'primary'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await s?.onConfirm();
            } finally {
              setBusy(false);
              onClose();
            }
          }}
        >
          {busy ? 'Working…' : s?.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
