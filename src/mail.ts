import type { Env } from './types';

/**
 * Outbound email, via the Resend REST API.
 *
 * Called with fetch rather than a client library, for the same reasons as
 * src/stripe.ts: one endpoint is needed, and it keeps the Worker free of Node
 * compatibility shims. Workers cannot open an SMTP connection at all, so an
 * HTTP mail API is the only route off the platform.
 */

const RESEND_API = 'https://api.resend.com/emails';

/** Where the contact form delivers when CONTACT_EMAIL is not set. */
const DEFAULT_TO = 'coyoteridgeairsoft@gmail.com';

/**
 * Resend refuses any `from` outside a domain verified on the account, so there
 * is no useful default here -- an unverified guess would fail on every send.
 * `onboarding@resend.dev` needs no DNS but only delivers to the address that
 * owns the Resend account, which makes it right for local testing and wrong
 * for production. Set CONTACT_FROM in wrangler.jsonc to a verified sender.
 */
const DEFAULT_FROM = 'Coyote Ridge Airsoft <onboarding@resend.dev>';

export const isMailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY?.trim());

export const contactRecipient = (env: Env) => env.CONTACT_EMAIL?.trim() || DEFAULT_TO;

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

export type MailResult = { ok: true } | { ok: false; error: string };

/**
 * Sends one contact-form message to the field's inbox.
 *
 * Never throws, and never rejects: the caller has already stored the message,
 * and a transport failure must not turn into a 500 that tells the visitor to
 * send it again. Failures come back as `{ ok: false, error }` to be recorded
 * against the stored row.
 */
export async function sendContactEmail(env: Env, msg: ContactMessage): Promise<MailResult> {
  if (!isMailConfigured(env)) return { ok: false, error: 'not_configured' };

  // Deliberately plain text: a contact form is an open door, and rendering a
  // stranger's message as HTML in the field's mailbox would hand them the
  // ability to put working links and markup in front of staff.
  const body = [
    `From:    ${msg.name} <${msg.email}>`,
    `Sent:    ${new Date().toISOString()}`,
    '',
    msg.message,
    '',
    '-- ',
    'Sent from the contact form on the Coyote Ridge Airsoft website.',
    'Reply to this email to answer the sender directly.',
  ].join('\n');

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.CONTACT_FROM?.trim() || DEFAULT_FROM,
        to: [contactRecipient(env)],
        // The whole point of the form: hitting Reply in the inbox answers the
        // visitor, not the Worker.
        reply_to: msg.email,
        subject: `Website message from ${msg.name}`,
        text: body,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `resend_${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `fetch_failed: ${String(err).slice(0, 300)}` };
  }
}
