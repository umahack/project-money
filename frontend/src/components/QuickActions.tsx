import { NavLink } from 'react-router-dom';

/**
 * Top-of-dashboard shortcut row for the three primary user actions. Mobile
 * users shouldn't have to scroll past the plan donut + today strip + streak
 * card to find "add expense" — the shortcuts live here, above the fold.
 * On ≤520px they stack as a single row of equal-flex tiles.
 */
export function QuickActions() {
  return (
    <nav className="quick-actions" aria-label="Quick actions">
      <NavLink to="/spending" className="qa-tile" title="Log a new expense">
        <span className="qa-icon" aria-hidden="true">💸</span>
        <span className="qa-label">Add expense</span>
      </NavLink>
      <NavLink to="/plan" className="qa-tile" title="Plan the month">
        <span className="qa-icon" aria-hidden="true">🧾</span>
        <span className="qa-label">Plan month</span>
      </NavLink>
      <NavLink to="/goals" className="qa-tile" title="Set or update a savings goal">
        <span className="qa-icon" aria-hidden="true">🎯</span>
        <span className="qa-label">Savings goal</span>
      </NavLink>
      <NavLink to="/trips" className="qa-tile" title="Create or open a trip">
        <span className="qa-icon" aria-hidden="true">✈️</span>
        <span className="qa-label">Trip split</span>
      </NavLink>
    </nav>
  );
}
