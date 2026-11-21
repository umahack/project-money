import { useEffect } from 'react';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import './dataUse.css';

/**
 * The Core Promise, rendered above routed content in every new session before
 * the first financial input is enabled (Requirements 1.1 and 1.2). It marks a
 * session-only flag after rendering; the flag holds no financial data.
 */
export function CorePromiseStrip() {
  const { status, markPromiseShown } = useDataUseGate();
  const visible = status !== 'disabled';

  useEffect(() => {
    if (visible) markPromiseShown();
  }, [visible, markPromiseShown]);

  if (!visible) return null;

  return (
    <section className="clarity-promise" aria-labelledby="clarity-promise-title">
      <h2 id="clarity-promise-title" className="clarity-promise-title">
        See what is safe to spend, what to save, and what to do next.
      </h2>
      <p className="clarity-promise-lead">
        Project Money connects four parts of your money, so each answer builds on the one before it.
      </p>
      <ol className="clarity-promise-flow">
        <li><strong>Plan:</strong> your pay minus your monthly bills shows how much you can spend and save.</li>
        <li><strong>Spending:</strong> your expenses show whether this month is on track.</li>
        <li><strong>Saving:</strong> goals show what to set aside each month.</li>
        <li><strong>Trips:</strong> shared costs show what you owe or are owed.</li>
      </ol>
    </section>
  );
}
