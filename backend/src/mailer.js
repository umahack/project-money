import { Resend } from 'resend';

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'Project Money <onboarding@resend.dev>';
const resend = KEY ? new Resend(KEY) : null;

/**
 * Send a transactional email. If RESEND_API_KEY is unset the code is logged
 * to stdout so local dev and preview deploys still work. The return shape is
 * identical in both paths so the caller can show `mail.fallback` if needed.
 */
export async function sendMail({ to, subject, html, text }) {
  if (!resend) {
    console.log(`[mail-fallback] to=${to} subject="${subject}"\n${text || html}`);
    return { ok: true, fallback: true };
  }
  try {
    const res = await resend.emails.send({ from: FROM, to, subject, html, text });
    if (res.error) throw new Error(res.error.message || 'send failed');
    return { ok: true, id: res.data?.id };
  } catch (err) {
    console.error('[mail-error]', err.message);
    return { ok: false, error: err.message };
  }
}

const grad = 'linear-gradient(90deg,#7c6cff,#4ade80,#fbbf24)';
const brand = (title) => `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0b0b1a;color:#f4f4f5;padding:28px;border-radius:16px;max-width:480px;margin:auto">
    <div style="font-size:24px;font-weight:800;background:${grad};-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:12px">Project Money</div>
    <div>${title}</div>
  </div>`;

const codeBlock = (code) => `
  <p style="font-size:28px;letter-spacing:0.4em;font-weight:800;background:#1f1f36;padding:14px 18px;border-radius:12px;text-align:center">${code}</p>
  <p style="color:#a1a1aa;font-size:12px">Code expires in 15 minutes. If you weren't expecting this, you can safely ignore this email.</p>`;

export function registerVerifyEmail(code, name) {
  const safeName = String(name || '').replace(/[<>]/g, '').slice(0, 60);
  const greeting = safeName ? `Hey ${safeName}, welcome!` : 'Welcome!';
  const text =
    `Project Money\n\n${greeting}\nConfirm this email to finish creating your account.\n\n` +
    `Your 6-digit code: ${code}\n\nCode expires in 15 minutes.`;
  const html = brand(
    `<p>${greeting}</p><p>Confirm this email to finish creating your account.</p>${codeBlock(code)}`
  );
  return { subject: 'Your Project Money sign-up code', text, html };
}

export function monthlyReviewEmail({ name, monthLabel, income, needs, wants, save, saveTarget, top3, streak }) {
  // User-provided strings get full HTML entity-escaping before landing in
  // any HTML context (text node OR attribute value).
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const safeName = esc(name).slice(0, 60);
  const greeting = safeName ? `Hi ${safeName},` : 'Hi,';
  const inr = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '₹0';
    return '₹' + v.toLocaleString('en-IN');
  };
  const topLines = Array.isArray(top3) ? top3.map((t, i) => `${i + 1}. ${t.category} — ${inr(t.total)}`).join('\n') : '';
  const topHtml = Array.isArray(top3)
    ? top3.map((t, i) => `<tr><td style="padding:4px 10px;color:#a1a1aa">${i + 1}</td><td style="padding:4px 10px"><b>${esc(t.category)}</b></td><td style="padding:4px 10px;text-align:right">${inr(t.total)}</td></tr>`).join('')
    : '';
  const saveHit = Number(save) >= Number(saveTarget || 0);
  const text =
    `Project Money\n\n${greeting}\nYour ${monthLabel} wrap-up is in:\n\n` +
    `Income       ${inr(income)}\n` +
    `Needs spent  ${inr(needs)}\n` +
    `Wants spent  ${inr(wants)}\n` +
    `Saved        ${inr(save)}  ${saveHit ? '✓ target hit' : ''}\n\n` +
    (topLines ? `Top categories:\n${topLines}\n\n` : '') +
    (streak ? `Logging streak: ${streak} day${streak === 1 ? '' : 's'} 🔥\n\n` : '') +
    `Open the app → https://project-money.online\n` +
    `To unsubscribe, email hello@project-money.online.`;
  const html = brand(
    `<p>${greeting}</p>` +
    `<p>Here's your <b>${esc(monthLabel)}</b> wrap-up:</p>` +
    `<table style="border-collapse:collapse;width:100%;margin:12px 0">` +
    `<tr><td style="padding:6px 10px">Income</td><td style="padding:6px 10px;text-align:right"><b>${inr(income)}</b></td></tr>` +
    `<tr><td style="padding:6px 10px">Needs spent</td><td style="padding:6px 10px;text-align:right">${inr(needs)}</td></tr>` +
    `<tr><td style="padding:6px 10px">Wants spent</td><td style="padding:6px 10px;text-align:right">${inr(wants)}</td></tr>` +
    `<tr><td style="padding:6px 10px">Saved</td><td style="padding:6px 10px;text-align:right"><b style="color:${saveHit ? '#4ade80' : '#fbbf24'}">${inr(save)}${saveHit ? ' ✓' : ''}</b></td></tr>` +
    `</table>` +
    (topHtml ? `<p style="color:#a1a1aa;margin:16px 0 4px">Top categories</p><table style="border-collapse:collapse;width:100%">${topHtml}</table>` : '') +
    (streak ? `<p style="margin-top:16px">Logging streak: <b>${streak} day${streak === 1 ? '' : 's'}</b> 🔥</p>` : '') +
    `<p style="margin-top:20px"><a href="https://project-money.online" style="color:#4ade80;font-weight:600">Open Project Money →</a></p>` +
    `<p style="color:#a1a1aa;font-size:12px;margin-top:20px">To unsubscribe, reply with "unsubscribe" or email <a href="mailto:hello@project-money.online" style="color:#a1a1aa">hello@project-money.online</a>.</p>`
  );
  return { subject: `Your ${monthLabel} money wrap-up`, text, html };
}

export function alreadyRegisteredEmail(name) {
  const safeName = String(name || '').replace(/[<>]/g, '').slice(0, 60);
  const greeting = safeName ? `Hi ${safeName},` : 'Hi,';
  const text =
    `Project Money\n\n${greeting}\nSomeone tried to create a Project Money account using this email,` +
    ` but you already have one. If this was you, you can sign in at https://project-money.online/login` +
    ` — and if you forgot your password, reset it at https://project-money.online/forgot-password.` +
    `\n\nIf it wasn't you, you can safely ignore this email — no account was created, nothing changed.`;
  const html = brand(
    `<p>${greeting}</p>` +
    `<p>Someone tried to create a Project Money account using this email, but you already have one.</p>` +
    `<p>If it was you: <a href="https://project-money.online/login" style="color:#4ade80">sign in</a>, or ` +
    `<a href="https://project-money.online/forgot-password" style="color:#4ade80">reset your password</a>.</p>` +
    `<p style="color:#a1a1aa;font-size:12px">If it wasn't you, you can safely ignore this email — no account was created, nothing changed.</p>`
  );
  return { subject: 'Someone tried to sign up with your email', text, html };
}

export function passwordResetEmail(code, name) {
  const safeName = String(name || '').replace(/[<>]/g, '').slice(0, 60);
  const greeting = safeName ? `Hi ${safeName},` : 'Hi,';
  const text =
    `Project Money\n\n${greeting}\nUse this 6-digit code to reset your password:\n\n` +
    `${code}\n\nCode expires in 15 minutes. If you didn't request this, ignore this email — your password won't change.`;
  const html = brand(
    `<p>${greeting}</p><p>Use this code to reset your Project Money password.</p>${codeBlock(code)}` +
    `<p style="color:#a1a1aa;font-size:12px">If you didn't request this, you can safely ignore this email — your password won't change.</p>`
  );
  return { subject: 'Reset your Project Money password', text, html };
}

export function emailChangeVerifyEmail(code, oldEmail) {
  const safeOld = String(oldEmail || '').replace(/[<>]/g, '').slice(0, 100);
  const text =
    `Project Money\n\nYou asked to change the email on your account (currently ${safeOld}) to this address.\n\n` +
    `Your 6-digit code: ${code}\n\nCode expires in 15 minutes. If this wasn't you, you can safely ignore this email — nothing changes.`;
  const html = brand(
    `<p>Confirm this new email address for your Project Money account.</p>` +
    `<p style="color:#a1a1aa;font-size:13px">Current email on file: <b>${safeOld}</b></p>${codeBlock(code)}`
  );
  return { subject: 'Confirm your new Project Money email', text, html };
}
