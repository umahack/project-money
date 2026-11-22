import { useEffect, useId, useState } from 'react';
import { useDataUseGate } from '../../clarity/DataUseGateProvider';
import './dataUse.css';

/**
 * The Core Promise, rendered above routed content in every new session before
 * the first financial input is enabled (Requirements 1.1 and 1.2). It is one
 * short line; "How it works" opens the four connected parts. It marks a
 * session-only flag after rendering; the flag holds no financial data.
 */
export function CorePromiseStrip() {
  const { status, markPromiseShown } = useDataUseGate();
  const visible = status !== 'disabled';
  const detailsId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (visible) markPromiseShown();
  }, [visible, markPromiseShown]);

  if (!visible) return null;

  return (
    <section className="clarity-promise" aria-labelledby="clarity-promise-title">
      <div className="clarity-promise-line">
        <h2 id="clarity-promise-title" className="clarity-promise-title">
          See what is safe to spend, what to save, and what to do next.
        </h2>
        <button
          type="button"
          className="btn ghost sm clarity-promise-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" className="clarity-chevron">{open ? '▾' : '▸'}</span>
          How it works
        </button>
      </div>
      <div id={detailsId} className="clarity-promise-details" hidden={!open}>
        <p className="clarity-promise-lead">
          Project Money connects four parts of your money, so each answer builds on the one before it.
        </p>
        <ol className="clarity-promise-flow">
          <li><strong>Plan:</strong> your pay minus your monthly bills shows how much you can spend and save.</li>
          <li><strong>Spending:</strong> your expenses show whether this month is on track.</li>
          <li><strong>Saving:</strong> goals show what to set aside each month.</li>
          <li><strong>Trips:</strong> shared costs show what you owe or are owed.</li>
        </ol>
      </div>
    </section>
  );
}
