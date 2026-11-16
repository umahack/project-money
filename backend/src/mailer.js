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
