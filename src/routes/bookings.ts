import { Hono } from 'hono';
import type { AppBindings, AttendeeRow, BookingRow, EventRow, PackageRow } from '../types';
import { ApiError, optionalString, requireEmail, requireInt, requireString } from '../validate';
import {
  addMinutes,
  baseUrl,
  holdMinutes,
  newAttendeeToken,
  newBookingRef,
  nowIso,
} from '../db';

export const bookings = new Hono<AppBindings>();

/**
 * Reserves `count` spots on an event with a single conditional UPDATE.
 *
 * This is the whole oversell defence, and it is written as one statement on
 * purpose: a read-then-write would let two concurrent requests both observe the
 * last spot as free. If no row changed, the event is full, cancelled, or gone --
 * we do not need to know which to reject the booking.
 */
export function reserveSpotsStmt(db: D1Database, eventId: number, count: number) {
  return db
    .prepare(
      `UPDATE events
          SET spots_taken = spots_taken + ?1
        WHERE id = ?2
          AND status = 'scheduled'
          AND spots_taken + ?1 <= capacity`,
    )
    .bind(count, eventId);
}

/** Gives spots back. Clamped at zero so a double-release can never go negative. */
export function releaseSpotsStmt(db: D1Database, eventId: number, count: number) {
  return db
    .prepare(
      `UPDATE events
          SET spots_taken = MAX(0, spots_taken - ?1)
        WHERE id = ?2`,
    )
    .bind(count, eventId);
}

bookings.post('/bookings', async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  const eventSlug = requireString(body, 'eventSlug', 100);
  const packageId = requireString(body, 'packageId', 50);
  const partySize = requireInt(body, 'partySize', 1, 20);
  const name = requireString(body, 'name', 120);
  const email = requireEmail(body, 'email');
  const phone = optionalString(body, 'phone', 40);

  const event = await c.env.DB.prepare(
    `SELECT id, slug, title, starts_at, capacity, spots_taken, status
       FROM events WHERE slug = ?1`,
  )
    .bind(eventSlug)
    .first<Pick<EventRow, 'id' | 'slug' | 'title' | 'starts_at' | 'capacity' | 'spots_taken' | 'status'>>();

  if (!event) throw new ApiError(404, 'event_not_found', 'No such game day.');
  if (event.status !== 'scheduled') {
    throw new ApiError(409, 'event_unavailable', 'That game day is no longer open for booking.');
  }
  if (event.starts_at <= nowIso()) {
    throw new ApiError(409, 'event_past', 'That game day has already started.');
  }

  const pkg = await c.env.DB.prepare(
    `SELECT id, name, price_cents FROM packages WHERE id = ?1 AND active = 1`,
  )
    .bind(packageId)
    .first<Pick<PackageRow, 'id' | 'name' | 'price_cents'>>();
  if (!pkg) throw new ApiError(404, 'package_not_found', 'No such package.');

  // Price is computed here, from the database. Whatever total the client
  // displayed is never read.
  const amountCents = pkg.price_cents * partySize;

  // Upsert the player. Email is identity; a returning player updates in place
  // rather than accumulating duplicate rows.
  const player = await c.env.DB.prepare(
    `INSERT INTO players (email, full_name, phone)
          VALUES (?1, ?2, ?3)
     ON CONFLICT (email) DO UPDATE
            SET full_name  = excluded.full_name,
                phone      = COALESCE(excluded.phone, players.phone),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING id, blacklisted`,
  )
    .bind(email, name, phone)
    .first<{ id: number; blacklisted: number }>();

  if (!player) throw new ApiError(500, 'player_upsert_failed', 'Could not record the player.');
  if (player.blacklisted) {
    throw new ApiError(403, 'player_blocked', 'This account cannot book. Please contact the field.');
  }

  const reserved = await reserveSpotsStmt(c.env.DB, event.id, partySize).run();
  if (reserved.meta.changes === 0) {
    // Re-read rather than reusing the count from above: in the case this branch
    // exists for, somebody else took the spots in between and the earlier number
    // is exactly the one that was wrong.
    const current = await c.env.DB.prepare(
      `SELECT capacity, spots_taken FROM events WHERE id = ?1`,
    )
      .bind(event.id)
      .first<{ capacity: number; spots_taken: number }>();
    const left = Math.max(0, (current?.capacity ?? 0) - (current?.spots_taken ?? 0));
    throw new ApiError(
      409,
      'sold_out',
      left > 0
        ? `Only ${left} spot${left === 1 ? '' : 's'} left on that game day.`
        : 'That game day is sold out.',
    );
  }

  // From here on the spots are held. Any failure below must give them back.
  const ref = newBookingRef();
  const holdExpiresAt = addMinutes(nowIso(), holdMinutes(c.env));

  try {
    const booking = await c.env.DB.prepare(
      `INSERT INTO bookings (ref, event_id, package_id, player_id, party_size,
                             amount_cents, status, hold_expires_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending_payment', ?7)
         RETURNING id`,
    )
      .bind(ref, event.id, pkg.id, player.id, partySize, amountCents, holdExpiresAt)
      .first<{ id: number }>();

    if (!booking) throw new Error('booking insert returned no row');

    // One attendee row per person -- each needs their own waiver. Seat 1 is
    // pre-filled with the booker; the rest are filled in as people sign.
    const attendeeStmt = c.env.DB.prepare(
      `INSERT INTO booking_attendees (booking_id, seat_no, attendee_token, player_id, full_name, email)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    );
    const tokens: string[] = [];
    const inserts = [];
    for (let seat = 1; seat <= partySize; seat++) {
      const token = newAttendeeToken();
      tokens.push(token);
      inserts.push(
        seat === 1
          ? attendeeStmt.bind(booking.id, seat, token, player.id, name, email)
          : attendeeStmt.bind(booking.id, seat, token, null, null, null),
      );
    }
    await c.env.DB.batch(inserts);

    const origin = baseUrl(c.env, c.req.raw);
    return c.json(
      {
        ref,
        eventSlug: event.slug,
        eventTitle: event.title,
        packageId: pkg.id,
        partySize,
        amountCents,
        status: 'pending_payment',
        holdExpiresAt,
        attendees: tokens.map((token, i) => ({
          seatNo: i + 1,
          token,
          waiverUrl: `${origin}/waiver?token=${token}`,
        })),
      },
      201,
    );
  } catch (err) {
    await releaseSpotsStmt(c.env.DB, event.id, partySize).run();
    throw err;
  }
});

bookings.get('/bookings/:ref', async (c) => {
  const booking = await c.env.DB.prepare(
    `SELECT b.id, b.ref, b.event_id, b.package_id, b.player_id, b.party_size,
            b.amount_cents, b.currency, b.status, b.hold_expires_at, b.overbooked,
            b.stripe_session_id, b.stripe_session_expires_at, b.stripe_payment_intent,
            b.paid_at, b.created_at,
            e.slug AS event_slug, e.title AS event_title, e.starts_at AS event_starts_at,
            p.name AS package_name
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       JOIN packages p ON p.id = b.package_id
      WHERE b.ref = ?1`,
  )
    .bind(c.req.param('ref'))
    .first<BookingRow & {
      event_slug: string;
      event_title: string;
      event_starts_at: string;
      package_name: string;
    }>();

  if (!booking) throw new ApiError(404, 'booking_not_found', 'No booking with that reference.');

  const { results: attendees } = await c.env.DB.prepare(
    `SELECT a.id, a.seat_no, a.attendee_token, a.full_name, a.email, a.is_minor,
            a.waiver_id, a.checked_in_at, a.chrono_ok,
            w.signed_at, w.expires_at
       FROM booking_attendees a
       LEFT JOIN waivers w ON w.id = a.waiver_id
      WHERE a.booking_id = ?1
      ORDER BY a.seat_no`,
  )
    .bind(booking.id)
    .all<AttendeeRow & { signed_at: string | null; expires_at: string | null }>();

  const origin = baseUrl(c.env, c.req.raw);
  const now = nowIso();

  return c.json({
    ref: booking.ref,
    status: booking.status,
    event: {
      slug: booking.event_slug,
      title: booking.event_title,
      startsAt: booking.event_starts_at,
    },
    packageId: booking.package_id,
    packageName: booking.package_name,
    partySize: booking.party_size,
    amountCents: booking.amount_cents,
    currency: booking.currency,
    holdExpiresAt: booking.hold_expires_at,
    paidAt: booking.paid_at,
    overbooked: Boolean(booking.overbooked),
    attendees: attendees.map((a) => ({
      seatNo: a.seat_no,
      token: a.attendee_token,
      waiverUrl: `${origin}/waiver?token=${a.attendee_token}`,
      name: a.full_name,
      email: a.email,
      isMinor: a.is_minor === null ? null : Boolean(a.is_minor),
      waiverSigned: a.waiver_id !== null,
      waiverValid: a.waiver_id !== null && (a.expires_at ?? '') > now,
      waiverSignedAt: a.signed_at,
      waiverExpiresAt: a.expires_at,
      checkedInAt: a.checked_in_at,
      chronoOk: Boolean(a.chrono_ok),
    })),
  });
});
