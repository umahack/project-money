import { motion } from 'framer-motion';
import { Card, Money } from './ui';
import { inr } from '../money';
import { buildProjection } from '../insights';
import type { Plan } from '../types';

/**
 * The "point of the app" in one tile. Shows what the user's monthly save
 * compounds to over 5 years at an 8% SIP, and what cutting wants by 20%
 * unlocks on top. Not advice — math.
 */
export function FiveYearProjection({ plan, demo = false }: { plan: Plan; demo?: boolean }) {
  const p = buildProjection(plan);
  if (plan.breakdown.save <= 0) return null;
  const lift = p.fiveYearIfCutWants20 - p.fiveYear;
  return (
    <Card tilt className="projection-card">
      <div className="row between wrap" style={{ gap: '0.4rem' }}>
        <h2 style={{ margin: 0 }}>🧠 The point</h2>
        {demo && <span className="pill info">Sample</span>}
      </div>
      <p className="muted small" style={{ marginTop: 4, marginBottom: '0.8rem' }}>
        Saving {inr(p.monthlySave)}/month at 8% returns compounds to this in 5 years.
      </p>
      <div className="row between wrap" style={{ gap: '0.8rem', alignItems: 'baseline' }}>
        <div>
          <span className="muted small">Projected 5-year corpus</span>
          <Money value={p.fiveYear} className="big accent" />
        </div>
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          style={{ textAlign: 'right' }}
        >
          <span className="muted small">If you trim wants 20%</span>
          <strong className="mono" style={{ fontSize: '1.15rem', color: 'var(--c-save)' }}>
            +{inr(lift)}
          </strong>
        </motion.div>
      </div>
      <p className="muted tiny" style={{ marginTop: '0.6rem' }}>
        Assumes 8% annual returns, compounded monthly. For perspective — not investment advice.
      </p>
    </Card>
  );
}
