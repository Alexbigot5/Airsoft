import { Hono } from 'hono';
import type { AppBindings, BookingRow, Env } from '../types';
import { ApiError } from '../validate';
import { baseUrl, holdMinutes, nowIso } from '../db';
import {
  createCheckoutSession,
  isStripeConfigured,
  verifyWebhook,
  type StripeEvent,
} from '../stripe';
import { releaseSpotsStmt, reserveSpotsStmt } from './bookings';

export const checkout = new Hono<AppBindings>();

type BookingJoin = BookingRow & {
  event_slug: string;
  event_title: string;
  event_starts_at: string;
  package_name: string;
  player_email: string;
};

const BOOKING_SQL = `
  SELECT b.id, b.ref, b.event_id, b.package_id, b.player_id, b.party_size, b.amount_cents,
         b.currency, b.status, b.hold_expires_at, b.overbooked, b.stripe_session_id,
         b.stripe_session_expires_at, b.stripe_payment_intent, b.paid_at, b.created_at,
         e.slug AS event_slug, e.title AS event_title, e.starts_at AS event_starts_at,
         p.name AS package_name, pl.email AS player_email
    FROM bookings b
    JOIN events e ON e.id = b.event_id
    JOIN packages p ON p.id = b.package_id
    JOIN players pl ON pl.id = b.player_id`;

const loadBookingByRef = (env: Env, ref: string) =>
  env.DB.prepare(`${BOOKING_SQL} WHERE b.ref = ?1`).bind(ref).first<BookingJoin>();

// ---------------------------------------------------------------------------
// Booking state transitions driven by payment
// ---------------------------------------------------------------------------

/**
 * Promotes a booking to paid.
 *
 * The awkward case this exists to handle: the hold may already have been swept
 * (status 'expired') by the time the money lands. Rather than silently taking
 * payment for a spot that was given away, we try to re-reserve; if the event has
 * since filled we still record the payment but flag the booking so staff see it.
 */
async function markPaid(
  env: Env,
  booking: BookingJoin,
  detail: { sessionId?: string | null; paymentIntent?: string | null; raw?: unknown },
): Promise<void> {
  if (booking.status === 'paid') return; // idempotent

  let overbooked = 0;
  if (booking.status !== 'pending_payment') {
    const reserved = await reserveSpotsStmt(env.DB, booking.event_id, booking.party_size).run();
    if (reserved.meta.changes === 0) overbooked = 1;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings
          SET status = 'paid',
              hold_expires_at = NULL,
              overbooked = ?1,
              stripe_session_id = COALESCE(?2, stripe_session_id),
              stripe_payment_intent = COALESCE(?3, stripe_payment_intent),
              paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?4`,
    ).bind(overbooked, detail.sessionId ?? null, detail.paymentIntent ?? null, booking.id),
    env.DB.prepare(
      `INSERT INTO payments (booking_id, stripe_session_id, stripe_payment_intent,
                             amount_cents, currency, status, raw_json)
            VALUES (?1, ?2, ?3, ?4, ?5, 'succeeded', ?6)`,
    ).bind(
      booking.id,
      detail.sessionId ?? null,
      detail.paymentIntent ?? null,
      booking.amount_cents,
      booking.currency,
      detail.raw ? JSON.stringify(detail.raw).slice(0, 8000) : null,
    ),
  ]);

  if (overbooked) {
    console.warn(`booking ${booking.ref} paid after its hold expired and the event is full`);
  }
}

/** Releases the spots a booking is holding and moves it out of the live set. */
async function releaseBooking(
  env: Env,
  booking: BookingJoin,
  status: 'expired' | 'cancelled',
): Promise<void> {
  // Only a booking that is still holding spots should give any back.
  if (booking.status !== 'pending_payment' && booking.status !== 'paid') return;

  await env.DB.batch([
    releaseSpotsStmt(env.DB, booking.event_id, booking.party_size),
    env.DB.prepare(
      `UPDATE bookings
          SET status = ?1,
              hold_expires_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?2`,
    ).bind(status, booking.id),
  ]);
}

/**
 * Applies a verified Stripe event. Shared by the real webhook route and the
 * offline stub, so the stub exercises the production path rather than a
 * shortcut around it.
 *
 * Returns false if the event was a duplicate and nothing was applied.
 */
export async function processStripeEvent(
  env: Env,
  event: StripeEvent,
  rawBody: string,
): Promise<boolean> {
  if (!event?.id || !event.type) {
    throw new ApiError(400, 'invalid_event', 'Not a Stripe event.');
  }

  // Idempotency: this insert either wins, or tells us the event was already
  // handled. Stripe retries, and retries must not double-apply anything.
  try {
    await env.DB.prepare(`INSERT INTO webhook_events (id, type, payload) VALUES (?1, ?2, ?3)`)
      .bind(event.id, event.type, rawBody.slice(0, 16000))
      .run();
  } catch {
    return false;
  }

  const object = event.data?.object ?? {};
  const ref =
    (object.client_reference_id as string | undefined) ??
    (object.metadata as Record<string, string> | undefined)?.booking_ref;

  const findBooking = async (): Promise<BookingJoin | null> => {
    if (ref) return loadBookingByRef(env, ref);
    const sessionId = object.id as string | undefined;
    if (!sessionId) return null;
    return env.DB.prepare(`${BOOKING_SQL} WHERE b.stripe_session_id = ?1`)
      .bind(sessionId)
      .first<BookingJoin>();
  };

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const booking = await findBooking();
      if (!booking) break;
      // 'unpaid' means a delayed payment method is still settling. Wait for the
      // async success event rather than granting entry early.
      if (event.type === 'checkout.session.completed' && object.payment_status === 'unpaid') break;
      await markPaid(env, booking, {
        sessionId: object.id as string | undefined,
        paymentIntent: object.payment_intent as string | undefined,
        raw: object,
      });
      break;
    }

    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const booking = await findBooking();
      if (booking) await releaseBooking(env, booking, 'expired');
      break;
    }

    case 'charge.refunded': {
      const booking = await findBooking();
      if (!booking) break;
      await env.DB.prepare(
        `INSERT INTO payments (booking_id, stripe_payment_intent, amount_cents, currency,
                               status, raw_json)
              VALUES (?1, ?2, ?3, ?4, 'refunded', ?5)`,
      )
        .bind(
          booking.id,
          (object.payment_intent as string | undefined) ?? null,
          (object.amount_refunded as number | undefined) ?? booking.amount_cents,
          booking.currency,
          JSON.stringify(object).slice(0, 8000),
        )
        .run();

      // Only give the spot back if there is still a game to give it back for.
      if (booking.event_starts_at > nowIso()) {
        await releaseBooking(env, booking, 'cancelled');
      } else {
        await env.DB.prepare(
          `UPDATE bookings
              SET status = 'cancelled',
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1`,
        )
          .bind(booking.id)
          .run();
      }
      break;
    }

    default:
      break; // acknowledged and ignored
  }

  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

checkout.post('/bookings/:ref/checkout', async (c) => {
  const booking = await loadBookingByRef(c.env, c.req.param('ref'));
  if (!booking) throw new ApiError(404, 'booking_not_found', 'No booking with that reference.');

  if (booking.status === 'paid') {
    throw new ApiError(409, 'already_paid', 'That booking is already paid.');
  }
  if (booking.status !== 'pending_payment') {
    throw new ApiError(409, 'booking_inactive', 'That booking is no longer active.');
  }

  const origin = baseUrl(c.env, c.req.raw);

  const session = await createCheckoutSession(c.env, {
    bookingRef: booking.ref,
    // Stripe wants a unit price and a quantity; amount_cents is the authority,
    // and party_size always divides it because that is how it was computed.
    unitAmountCents: Math.round(booking.amount_cents / booking.party_size),
    quantity: booking.party_size,
    currency: booking.currency,
    productName: `${booking.event_title} — ${booking.package_name}`,
    customerEmail: booking.player_email,
    successUrl: `${origin}/success?ref=${encodeURIComponent(booking.ref)}`,
    cancelUrl: `${origin}/register?cancelled=${encodeURIComponent(booking.ref)}`,
    expiresInMinutes: holdMinutes(c.env),
  });

  await c.env.DB.prepare(
    `UPDATE bookings
        SET stripe_session_id = ?1,
            stripe_session_expires_at = ?2,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?3`,
  )
    .bind(session.id, session.expiresAt, booking.id)
    .run();

  return c.json({ url: session.url, expiresAt: session.expiresAt });
});

checkout.post('/stripe/webhook', async (c) => {
  const raw = await c.req.text();
  const event = await verifyWebhook(c.env, raw, c.req.header('Stripe-Signature'));
  const applied = await processStripeEvent(c.env, event, raw);
  return c.json({ received: true, duplicate: !applied });
});

// ---------------------------------------------------------------------------
// Offline checkout stub
//
// Only reachable when no Stripe key is configured. It exists so the full
// booking -> paid -> check-in path can be walked with no network access; a
// deployment with a real key 404s these.
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );

checkout.get('/dev/checkout', async (c) => {
  if (isStripeConfigured(c.env)) throw new ApiError(404, 'not_found', 'No such endpoint.');

  const booking = await loadBookingByRef(c.env, c.req.query('ref') ?? '');
  if (!booking) throw new ApiError(404, 'booking_not_found', 'No booking with that reference.');

  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulated checkout — ${escapeHtml(booking.ref)}</title>
<link rel="stylesheet" href="/app.css"></head>
<body>
  <main class="wrap narrow">
    <p class="badge warn">Local stub — Stripe is not configured</p>
    <h1>${escapeHtml(booking.event_title)}</h1>
    <p class="muted">${escapeHtml(booking.package_name)} × ${booking.party_size}</p>
    <p class="total">$${(booking.amount_cents / 100).toFixed(2)}</p>
    <form method="post" action="/api/dev/checkout/complete">
      <input type="hidden" name="ref" value="${escapeHtml(booking.ref)}">
      <button class="btn" type="submit">Simulate successful payment</button>
    </form>
    <p class="muted small">Stands in for Stripe Checkout. With STRIPE_SECRET_KEY set,
      players are sent to Stripe instead and this page does not exist.</p>
  </main>
</body></html>`);
});

checkout.post('/dev/checkout/complete', async (c) => {
  if (isStripeConfigured(c.env)) throw new ApiError(404, 'not_found', 'No such endpoint.');

  const form = await c.req.parseBody();
  const booking = await loadBookingByRef(c.env, String(form.ref ?? ''));
  if (!booking) throw new ApiError(404, 'booking_not_found', 'No booking with that reference.');

  const event: StripeEvent = {
    id: `evt_dev_${crypto.randomUUID()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: booking.stripe_session_id ?? `cs_dev_${booking.ref}`,
        client_reference_id: booking.ref,
        payment_status: 'paid',
        payment_intent: `pi_dev_${booking.ref}`,
        amount_total: booking.amount_cents,
      },
    },
  };

  await processStripeEvent(c.env, event, JSON.stringify(event));
  return c.redirect(`/success?ref=${encodeURIComponent(booking.ref)}`, 303);
});
