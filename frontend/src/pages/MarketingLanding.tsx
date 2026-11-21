import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Background } from '../components/Shell';
import { Donut } from '../components/ui';
import { JOURNEY_OUTCOMES, withJourneyIntent } from '../clarity/journeys';
import { selectFinancialClarityRollout } from '../clarity/rollout';

/**
 * Public landing page shown at "/" to unauthenticated visitors. Loud marketing
 * surface — hero, feature grid, testimonials — with Sign in / Sign up CTAs
 * routing to the clean form pages. Keeps /login and /register free of
 * marketing clutter.
 */

const FEATURES: Array<{ icon: string; title: string; text: string }> = [
  { icon: '💰', title: 'Plan your salary', text: 'Enter what credits each month — we split what\'s left into Needs, Wants, and Save.' },
  { icon: '📊', title: 'Track daily spend', text: 'One-tap log with 10 categories, inline budgets, and over/under alerts.' },
  { icon: '🎨', title: 'Customise everything', text: 'Rename, add, or delete your own categories, bills, and goals — nothing is locked.' },
  { icon: '🧠', title: 'Smart insights', text: 'Month-over-month deltas, weekday patterns, and category spikes auto-surface.' },
  { icon: '🎯', title: 'Savings goals', text: 'Set a target, watch progress, add or withdraw contributions as life happens.' },
  { icon: '✈️', title: 'Trip splits', text: 'Invite friends by email, log shared expenses, see who owes whom instantly.' },
];

const QUOTES: Array<{ text: string; author: string }> = [
  { text: 'This is so helpful for segregating daily expenditure and planning savings too.', author: 'Beta tester' },
  { text: 'Simple, easy to navigate, and makes managing money much easier.', author: 'Beta tester' },
  { text: 'Solves my all-time problems. I check whenever I want for updates.', author: 'Beta tester' },
];

const PREVIEW_SEGMENTS = [
  { label: 'Needs', value: 32500, color: 'var(--c-need)' },
  { label: 'Wants', value: 19500, color: 'var(--c-want)' },
  { label: 'Save', value: 13000, color: 'var(--c-save)' },
];

export function MarketingLanding() {
  return (
    <>
      <Background />
      <header className="auth-topbar">
        <Link to="/" className="brand" aria-label="Project Money home">
          <span className="brand-mark">₹</span>
          <span>Project&nbsp;Money</span>
          <span className="beta-badge" aria-label="Beta">BETA</span>
        </Link>
        <div className="top-actions">
          <Link to="/login" className="btn ghost sm">Sign in</Link>
          <Link to="/register" className="btn primary sm">Sign up</Link>
        </div>
      </header>

      <motion.section
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="landing"
        aria-labelledby="landing-title"
      >
        <div className="landing-hero">
          <span className="pill info landing-chip">BETA · Free to use</span>
          <h1 id="landing-title">
            Plan your money.<br />
            <span className="landing-grad">Split your trips.</span>
          </h1>
          <p className="landing-sub">
            A tiny web app that turns your monthly salary into a plan, your receipts into insights,
            and your group trips into a tidy settle-up — no spreadsheet required. Every category,
            bill, and goal is yours to rename, add, or delete.
          </p>
          <div className="landing-cta">
            <Link to="/register" className="btn primary">Create free account</Link>
            <a href="#features" className="btn ghost">See what's inside ↓</a>
          </div>
          <p className="muted tiny" style={{ marginTop: '0.8rem' }}>
            Already have an account? <Link to="/login" className="link">Sign in</Link>.
            Your data stays private to your account.
          </p>
        </div>

        <div className="landing-preview-card" aria-hidden="true">
          <div className="landing-mock-head">
            <span className="pill info">Live preview</span>
            <span className="muted tiny">Sample numbers — your real plan appears after sign-in</span>
          </div>
          <div className="landing-mock-grid">
            <div className="landing-mock-stat">
              <small className="muted">Salary</small>
              <b className="big">₹80,000</b>
            </div>
            <div className="landing-mock-stat">
              <small className="muted">Fixed/EMI</small>
              <b className="big">₹15,000</b>
            </div>
            <div className="landing-mock-stat">
              <small className="muted">Disposable</small>
              <b className="big">₹65,000</b>
            </div>
          </div>
          <div className="landing-mock-donut">
            <Donut segments={PREVIEW_SEGMENTS} centerTop="₹65,000" centerBottom="to allocate" />
          </div>
        </div>

        {selectFinancialClarityRollout().enabled && (
          <section aria-labelledby="landing-journeys">
            <h2 id="landing-journeys" className="landing-section-title">Start with one goal</h2>
            <ul className="landing-features" style={{ listStyle: 'none', padding: 0 }}>
              {JOURNEY_OUTCOMES.map((outcome) => (
                <li key={outcome.key}>
                  <Link className="landing-feature plain" to={withJourneyIntent('/register', outcome.key)} style={{ display: 'block' }}>
                    <h3>{outcome.title}</h3>
                    <p className="muted small">{outcome.description}</p>
                    <span className="open-link">Create a free account →</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <h2 id="features" className="landing-section-title">Everything you get, right out of the box</h2>
        <div className="landing-features">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              className="landing-feature"
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
            >
              <div className="landing-feature-icon" aria-hidden="true">{f.icon}</div>
              <h3>{f.title}</h3>
              <p className="muted small">{f.text}</p>
            </motion.div>
          ))}
        </div>

        <h2 className="landing-section-title">What early users said</h2>
        <div className="landing-quotes">
          {QUOTES.map((q, i) => (
            <motion.blockquote
              key={i}
              className="landing-quote"
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
            >
              <span className="stars-static" aria-label="5 star rating">★★★★★</span>
              <p>"{q.text}"</p>
              <cite>— {q.author}</cite>
            </motion.blockquote>
          ))}
        </div>

        <div className="landing-close-cta">
          <h2>Ready in 30 seconds</h2>
          <p className="muted">Name, email, password. We don't ask for anything else.</p>
          <Link to="/register" className="btn primary">Create free account →</Link>
          <p className="muted small" style={{ marginTop: '0.6rem' }}>
            Already here? <Link to="/login" className="link">Sign in instead</Link>.
          </p>
        </div>

        <footer className="muted tiny center" style={{ padding: '1.5rem 0' }}>
          <Link className="link" to="/privacy">Privacy</Link> · <Link className="link" to="/terms">Terms</Link>
        </footer>
      </motion.section>
    </>
  );
}
