import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { ApiError, field, requireEmail, requireString } from '../validate';
import { sendContactEmail } from '../mail';

export const contact = new Hono<AppBindings>();

/** How many messages one address may send before we start refusing. */
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_MINUTES = 10;

contact.post('/contact', async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  // Honeypot. The field is hidden from people and left empty by them, so
  // anything in it came from something filling in every input it found. The
  // response is the ordinary success shape: telling a bot it was spotted only
  // teaches whoever wrote it which field to skip next time.
  const honeypot = field(body, 'company');
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    return c.json({ ok: true });
  }

  const name = requireString(body, 'name', 120);
  const email = requireEmail(body, 'email');
  const message = requireString(body, 'message', 2000);

  const ip = c.req.header('CF-Connecting-IP') ?? null;

  // Flood check. Keyed on IP rather than email because the email is whatever
  // the sender typed, and costs one indexed COUNT against a table we are about
  // to write to anyway. Requests without an IP header skip it -- that is local
  // `wrangler dev` and the test suite, not a way through from the internet,
  // since Cloudflare sets the header on every edge request.
  if (ip) {
    const since = new Date(Date.now() - RATE_LIMIT_MINUTES * 60_000).toISOString();
    const recent = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contact_messages WHERE ip = ?1 AND created_at >= ?2`,
    )
      .bind(ip, since)
      .first<{ n: number }>();

    if ((recent?.n ?? 0) >= RATE_LIMIT_COUNT) {
      throw new ApiError(
        429,
        'too_many_messages',
        'That is a lot of messages. Please give it a few minutes, or call the field.',
      );
    }
  }

  // Store before sending. A message on disk that failed to email is a message
  // staff can still read; an email attempted first and lost to a crash is gone.
  const row = await c.env.DB.prepare(
    `INSERT INTO contact_messages (name, email, message, ip)
          VALUES (?1, ?2, ?3, ?4)
       RETURNING id`,
  )
    .bind(name, email, message, ip)
    .first<{ id: number }>();

  if (!row) throw new ApiError(500, 'message_not_stored', 'Could not record the message.');

  const sent = await sendContactEmail(c.env, { name, email, message });
  if (sent.ok) {
    await c.env.DB.prepare(`UPDATE contact_messages SET emailed = 1 WHERE id = ?1`)
      .bind(row.id)
      .run();
  } else {
    console.error(`contact message ${row.id} stored but not emailed: ${sent.error}`);
    await c.env.DB.prepare(`UPDATE contact_messages SET error = ?2 WHERE id = ?1`)
      .bind(row.id, sent.error)
      .run();
  }

  // The visitor is told the same thing either way, because from their side it
  // is true either way: the message has been received. Whether the field's
  // inbox notification went out is our problem to fix, not theirs to retry.
  return c.json({ ok: true });
});
