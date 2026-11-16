import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Background } from '../components/Shell';
import { Card } from '../components/ui';

function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <Background />
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Project Money home">
          <span className="brand-mark">₹</span>
          <span>Project&nbsp;Money</span>
        </Link>
        <div className="top-actions">
          <Link to="/login" className="btn ghost sm">Sign in</Link>
        </div>
      </header>
      <main className="container" style={{ maxWidth: 760 }}>
        <Card>
          <h1 style={{ marginTop: 0 }}>{title}</h1>
          <p className="muted small">Last updated: 2026-11-16</p>
          <div className="legal-body">{children}</div>
          <p className="muted small" style={{ marginTop: '2rem' }}>
            Questions? Reach us at <a className="link" href="mailto:hello@project-money.online">hello@project-money.online</a>.
          </p>
          <p className="muted small">
            <Link className="link" to="/privacy">Privacy</Link> · <Link className="link" to="/terms">Terms</Link> · <Link className="link" to="/">Home</Link>
          </p>
        </Card>
      </main>
    </>
  );
}

export function Privacy() {
  return (
    <LegalShell title="Privacy Policy">
      <h2>What this is</h2>
      <p>
        Project Money is a personal-finance planner built and operated by an individual developer
        (Umakanth, India). This page explains what data we collect, why, and your rights over it.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><b>Account data:</b> email address, display name, bcrypt-hashed password.</li>
        <li><b>Usage data you enter:</b> salary entries, EMIs, expenses, savings goals, recurring expenses, trips, trip members, trip expenses, feedback you submit.</li>
        <li><b>Session data:</b> device user-agent (truncated), a daily-rotating SHA-256 hash of your IP (we never store raw IPs), timestamps for sign-in / last activity.</li>
        <li><b>Verification codes:</b> for sign-up and email changes we temporarily store a bcrypt hash of a 6-digit one-time code; it is deleted immediately after use and expires in 15 minutes.</li>
      </ul>

      <h2>Why we collect it</h2>
      <ul>
        <li>To let you sign in on up to 3 devices and keep the plan you build visible across them.</li>
        <li>To send transactional email (sign-up code, email-change code, password reset) via Resend.</li>
        <li>To prevent abuse — rate limits, duplicate-account checks, visitor counts.</li>
        <li>To respond to feedback you submit through the in-app form.</li>
      </ul>

      <h2>Who else sees it</h2>
      <ul>
        <li><b>Resend</b> — handles outbound email. Sees your email address and the code we ask them to deliver.</li>
        <li><b>Turso</b> — managed SQLite that stores the database.</li>
        <li><b>Render</b> — hosts the API and the web app.</li>
      </ul>
      <p>We don't sell your data, run advertising networks, or share it with third parties beyond the hosts above.</p>

      <h2>Your rights</h2>
      <ul>
        <li><b>Export</b> — download your data as JSON from Settings → "Export my data".</li>
        <li><b>Delete</b> — permanently delete your account and all associated rows from Settings → "Delete account". This cannot be undone.</li>
        <li><b>Correct</b> — edit your name, email, and any financial data from the app directly.</li>
      </ul>

      <h2>Retention</h2>
      <p>
        We keep your data while your account is active. When you delete your account, every row tied
        to it is removed from the primary database on request. Database backups cycle out within 30 days.
      </p>

      <h2>Security</h2>
      <p>
        Passwords are bcrypt-hashed with cost 12. Sessions are revocable per-device with a
        3-device cap. Transport is HTTPS-only with HSTS preload. The service is in active
        development; report issues to the email above.
      </p>

      <h2>Children</h2>
      <p>Project Money is not intended for users under 13.</p>

      <h2>Changes</h2>
      <p>We'll update the "Last updated" date above when this policy changes.</p>
    </LegalShell>
  );
}

export function Terms() {
  return (
    <LegalShell title="Terms of Service">
      <h2>Agreement</h2>
      <p>
        By creating an account you agree to use Project Money responsibly and to the terms below.
        If you do not agree, do not use the service.
      </p>

      <h2>Service as-is</h2>
      <p>
        Project Money is provided <b>as-is</b>, without warranties of any kind. It is a planning tool,
        not professional financial advice. You remain responsible for every financial decision you
        make. We make no guarantee of uninterrupted availability — this is a beta product in active
        development.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>One account per person. You are responsible for the security of your password.</li>
        <li>Up to 3 devices can be signed in at once. A 4th sign-in revokes the oldest.</li>
        <li>Do not share your account; do not create accounts on behalf of others without consent.</li>
      </ul>

      <h2>Acceptable use</h2>
      <ul>
        <li>No automated scraping, abuse, or load generation against the API.</li>
        <li>No attempts to access data you don't own.</li>
        <li>No illegal content in feedback, trip names, or any free-text field.</li>
        <li>No reverse-engineering of security controls.</li>
      </ul>

      <h2>Trip sharing</h2>
      <p>
        When you enable a public trip link, anyone with that URL can view the trip's expenses and
        splits. You can revoke the link at any time from the trip page.
      </p>

      <h2>Termination</h2>
      <p>
        You can delete your account at any time from Settings. We may suspend accounts that violate
        these terms or threaten the stability of the service.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent allowed by law, Project Money and its developer are not liable for any direct,
        indirect, incidental, or consequential loss arising from use of the service.
      </p>

      <h2>Governing law</h2>
      <p>These terms are governed by the laws of India.</p>

      <h2>Changes</h2>
      <p>
        We may update these terms. Continued use after an update counts as acceptance. The
        "Last updated" date above reflects the current version.
      </p>
    </LegalShell>
  );
}
