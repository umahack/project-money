import { NavLink } from 'react-router-dom';

/**
 * Top-of-dashboard shortcut row for the four primary user actions, placed
 * directly after the greeting and next action so they are on the first screen.
 * Legacy rendering: one row of four tiles. Clarity rendering (see clarity.css):
 * a compact single row from 600px and a 2x2 grid of 48px tiles on phones.
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
