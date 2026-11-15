import { Resend } from 'resend';

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'Project Money <onboarding@resend.dev>';
const resend = KEY ? new Resend(KEY) : null;

/**
 * Send a transactional email. If RESEND_API_KEY is not set, logs to stdout so
 * local development and preview deploys work without a real email provider.
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

export function registerVerifyEmail(code) {
  const text =
    `Welcome to Project Money!\n\nYour verification code: ${code}\n\n` +
    `Enter this on the sign-up page to continue. The code expires in 15 minutes.`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0b0b1a;color:#f4f4f5;padding:28px;border-radius:16px;max-width:480px;margin:auto">
      <div style="font-size:24px;font-weight:800;background:linear-gradient(90deg,#7c6cff,#4ade80,#fbbf24);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:8px">Project Money</div>
      <p>Welcome! Confirm this email to finish creating your account.</p>
      <p style="font-size:28px;letter-spacing:0.4em;font-weight:800;background:#1f1f36;padding:14px 18px;border-radius:12px;text-align:center">${code}</p>
      <p style="color:#a1a1aa;font-size:12px">Code expires in 15 minutes. If you weren't signing up, you can ignore this email.</p>
    </div>`;
  return { subject: 'Your Project Money verification code', text, html };
}

export function aliasVerifyEmail(code, inviterEmail) {
  const safeInviter = inviterEmail.replace(/[<>]/g, '');
  const text =
    `Someone (${safeInviter}) wants to link this email to their Project Money account.\n\n` +
    `Verification code: ${code}\n\nCode expires in 15 minutes. If you weren't expecting this, ignore this email.`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0b0b1a;color:#f4f4f5;padding:28px;border-radius:16px;max-width:480px;margin:auto">
      <div style="font-size:24px;font-weight:800;background:linear-gradient(90deg,#7c6cff,#4ade80,#fbbf24);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:8px">Project Money</div>
      <p>Someone (<b>${safeInviter}</b>) wants to link this email to their account.</p>
      <p style="font-size:28px;letter-spacing:0.4em;font-weight:800;background:#1f1f36;padding:14px 18px;border-radius:12px;text-align:center">${code}</p>
      <p style="color:#a1a1aa;font-size:12px">Code expires in 15 minutes. If you weren't expecting this, you can safely ignore this email — the link won't happen.</p>
    </div>`;
  return { subject: 'Confirm your email for Project Money', text, html };
}
