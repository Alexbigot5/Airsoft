import { Hono } from 'hono';
import type { AppBindings, BookingRow, EventRow } from '../types';
import {
  ApiError,
  optionalString,
  requireBool,
  requireInt,
  requireString,
} from '../validate';
import { nowIso, sha256Hex, timingSafeEqual } from '../db';
import { releaseSpotsStmt } from './bookings';
import { sweepExpiredHolds } from '../sweeper';

export const admin = new Hono<AppBindings>();

/**
 * Shared-secret auth. Enough for a field crew with one staff token; swap for
 * Cloudflare Access in front of /admin if per-person identity is ever needed.
 */
admin.use('*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN?.trim();
  if (!expected) {
    throw new ApiError(500, 'admin_not_configured', 'ADMIN_TOKEN is not set on this deployment.');
  }

  const header = c.req.header('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !timingSafeEqual(presented, expected)) {
    throw new ApiError(401, 'unauthorized', 'Staff token required.');
  }
  await next();
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

admin.get('/events', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.slug, e.title, e.starts_at, e.ends_at, e.mode, e.field, e.level,
            e.capacity, e.spots_taken, e.base_price_cents, e.note, e.status,
            (SELECT COUNT(*) FROM bookings b
              WHERE b.event_id = e.id AND b.status = 'paid') AS paid_bookings
       FROM events e
      ORDER BY e.starts_at DESC
      LIMIT 200`,
  ).all<EventRow & { paid_bookings: number }>();

  return c.json({
    events: results.map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      mode: e.mode,
      field: e.field,
      level: e.level,
      capacity: e.capacity,
      spotsTaken: e.spots_taken,
      spotsLeft: Math.max(0, e.capacity - e.spots_taken),
      basePriceCents: e.base_price_cents,
      note: e.note,
      status: e.status,
      paidBookings: e.paid_bookings,
    })),
  });
});

admin.post('/events', async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  const slug = requireString(body, 'slug', 100).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new ApiError(400, 'invalid_slug', 'Slug may contain lowercase letters, digits and dashes.');
  }

  const row = await c.env.DB.prepare(
    `INSERT INTO events (slug, title, starts_at, ends_at, mode, field, level, capacity,
                         base_price_cents, note)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       RETURNING id`,
  )
    .bind(
      slug,
      requireString(body, 'title', 120),
      requireString(body, 'startsAt', 40),
      optionalString(body, 'endsAt', 40),
      optionalString(body, 'mode', 60),
      optionalString(body, 'field', 40) ?? 'woodland',
      optionalString(body, 'level', 40) ?? 'All levels',
      requireInt(body, 'capacity', 0, 1000),
      requireInt(body, 'basePriceCents', 0, 1_000_000),
      optionalString(body, 'note', 500),
    )
    .first<{ id: number }>()
    .catch(() => {
      throw new ApiError(409, 'slug_taken', 'An event with that slug already exists.');
    });

  return c.json({ id: row?.id, slug }, 201);
});

admin.patch('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  const event = await c.env.DB.prepare(
    `SELECT id, capacity, spots_taken FROM events WHERE id = ?1`,
  )
    .bind(id)
    .first<{ id: number; capacity: number; spots_taken: number }>();
  if (!event) throw new ApiError(404, 'event_not_found', 'No such event.');

  const updates: string[] = [];
  const binds: unknown[] = [];

  if ('capacity' in (body as object)) {
    const capacity = requireInt(body, 'capacity', 0, 1000);
    // Shrinking below what is already sold would break the events CHECK and,
    // more to the point, would mean people hold spots that no longer exist.
    if (capacity < event.spots_taken) {
      throw new ApiError(
        409,
        'capacity_below_booked',
        `${event.spots_taken} spots are already taken; capacity cannot be set below that.`,
      );
    }
    updates.push(`capacity = ?${binds.length + 1}`);
    binds.push(capacity);
  }

  if ('status' in (body as object)) {
    const status = requireString(body, 'status', 20);
    if (!['scheduled', 'cancelled', 'completed'].includes(status)) {
      throw new ApiError(400, 'invalid_status', 'Status must be scheduled, cancelled or completed.');
    }
    updates.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }

  for (const [key, column] of [
    ['title', 'title'],
    ['startsAt', 'starts_at'],
    ['endsAt', 'ends_at'],
    ['note', 'note'],
    ['level', 'level'],
    ['mode', 'mode'],
  ] as const) {
    if (key in (body as object)) {
      updates.push(`${column} = ?${binds.length + 1}`);
      binds.push(optionalString(body, key, 500));
    }
  }

  if (updates.length === 0) throw new ApiError(400, 'no_changes', 'Nothing to update.');

  binds.push(id);
  await c.env.DB.prepare(`UPDATE events SET ${updates.join(', ')} WHERE id = ?${binds.length}`)
    .bind(...binds)
    .run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Day-of roster -- the screen staff actually stand at the gate with
// ---------------------------------------------------------------------------

interface RosterRow {
  attendee_id: number;
  seat_no: number;
  booking_ref: string;
  booking_status: string;
  overbooked: number;
  party_size: number;
  amount_cents: number;
  attendee_name: string | null;
  attendee_email: string | null;
  booker_name: string;
  booker_email: string;
  is_minor: number | null;
  waiver_id: number | null;
  waiver_signed_at: string | null;
  waiver_expires_at: string | null;
  guardian_name: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  checked_in_at: string | null;
  chrono_ok: number;
}

admin.get('/events/:id/roster', async (c) => {
  const id = Number(c.req.param('id'));
  const event = await c.env.DB.prepare(
    `SELECT id, slug, title, starts_at, capacity, spots_taken, status FROM events WHERE id = ?1`,
  )
    .bind(id)
    .first<Pick<EventRow, 'id' | 'slug' | 'title' | 'starts_at' | 'capacity' | 'spots_taken' | 'status'>>();
  if (!event) throw new ApiError(404, 'event_not_found', 'No such event.');

  const { results } = await c.env.DB.prepare(
    `SELECT a.id AS attendee_id, a.seat_no, a.full_name AS attendee_name,
            a.email AS attendee_email, a.is_minor, a.waiver_id, a.checked_in_at, a.chrono_ok,
            b.ref AS booking_ref, b.status AS booking_status, b.overbooked,
            b.party_size, b.amount_cents,
            pl.full_name AS booker_name, pl.email AS booker_email,
            w.signed_at AS waiver_signed_at, w.expires_at AS waiver_expires_at,
            w.guardian_name, w.emergency_contact_name, w.emergency_contact_phone
       FROM booking_attendees a
       JOIN bookings b ON b.id = a.booking_id
       JOIN players pl ON pl.id = b.player_id
       LEFT JOIN waivers w ON w.id = a.waiver_id
      WHERE b.event_id = ?1
        AND b.status IN ('pending_payment', 'paid')
      ORDER BY b.created_at, a.seat_no`,
  )
    .bind(id)
    .all<RosterRow>();

  const now = nowIso();
  return c.json({
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      startsAt: event.starts_at,
      capacity: event.capacity,
      spotsTaken: event.spots_taken,
      status: event.status,
    },
    attendees: results.map((r) => ({
      attendeeId: r.attendee_id,
      seatNo: r.seat_no,
      bookingRef: r.booking_ref,
      bookingStatus: r.booking_status,
      overbooked: Boolean(r.overbooked),
      paid: r.booking_status === 'paid',
      name: r.attendee_name ?? `${r.booker_name} (seat ${r.seat_no})`,
      email: r.attendee_email ?? r.booker_email,
      isMinor: r.is_minor === null ? null : Boolean(r.is_minor),
      guardianName: r.guardian_name,
      emergencyContact:
        r.emergency_contact_name && r.emergency_contact_phone
          ? { name: r.emergency_contact_name, phone: r.emergency_contact_phone }
          : null,
      waiverSigned: r.waiver_id !== null,
      waiverValid: r.waiver_id !== null && (r.waiver_expires_at ?? '') > now,
      waiverSignedAt: r.waiver_signed_at,
      waiverExpiresAt: r.waiver_expires_at,
      checkedInAt: r.checked_in_at,
      chronoOk: Boolean(r.chrono_ok),
    })),
  });
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

admin.get('/bookings', async (c) => {
  const status = c.req.query('status');
  const eventId = c.req.query('eventId');

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push(`b.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (eventId) {
    where.push(`b.event_id = ?${binds.length + 1}`);
    binds.push(Number(eventId));
  }

  const { results } = await c.env.DB.prepare(
    `SELECT b.ref, b.status, b.party_size, b.amount_cents, b.overbooked, b.created_at,
            b.paid_at, b.hold_expires_at,
            e.title AS event_title, e.starts_at AS event_starts_at,
            pl.full_name AS booker_name, pl.email AS booker_email
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       JOIN players pl ON pl.id = b.player_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.created_at DESC
      LIMIT 200`,
  )
    .bind(...binds)
    .all<
      Pick<BookingRow, 'ref' | 'status' | 'party_size' | 'amount_cents' | 'overbooked' | 'created_at' | 'paid_at' | 'hold_expires_at'> & {
        event_title: string;
        event_starts_at: string;
        booker_name: string;
        booker_email: string;
      }
    >();

  return c.json({
    bookings: results.map((b) => ({
      ref: b.ref,
      status: b.status,
      partySize: b.party_size,
      amountCents: b.amount_cents,
      overbooked: Boolean(b.overbooked),
      createdAt: b.created_at,
      paidAt: b.paid_at,
      holdExpiresAt: b.hold_expires_at,
      eventTitle: b.event_title,
      eventStartsAt: b.event_starts_at,
      bookerName: b.booker_name,
      bookerEmail: b.booker_email,
    })),
  });
});

/** Cash or card at the gate -- records the money without going through Stripe. */
admin.post('/bookings/:ref/mark-paid', async (c) => {
  const booking = await c.env.DB.prepare(
    `SELECT id, ref, status, amount_cents, currency, event_id, party_size
       FROM bookings WHERE ref = ?1`,
  )
    .bind(c.req.param('ref'))
    .first<Pick<BookingRow, 'id' | 'ref' | 'status' | 'amount_cents' | 'currency' | 'event_id' | 'party_size'>>();

  if (!booking) throw new ApiError(404, 'booking_not_found', 'No booking with that reference.');
  if (booking.status === 'paid') return c.json({ ok: true, alreadyPaid: true });
  if (booking.status !== 'pending_payment') {
    throw new ApiError(409, 'booking_inactive', 'That booking is no longer active.');
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE bookings
          SET status = 'paid', hold_expires_at = NULL,
              paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1`,
    ).bind(booking.id),
    c.env.DB.prepare(
      `INSERT INTO payments (booking_id, provider, amount_cents, currency, status)
            VALUES (?1, 'manual', ?2, ?3, 'manual')`,
    ).bind(booking.id, booking.amount_cents, booking.currency),
  ]);

  return c.json({ ok: true });
});

admin.post('/bookings/:ref/cancel', async (c) => {
  const booking = await c.env.DB.prepare(
    `SELECT id, ref, status, event_id, party_size FROM bookings WHERE ref = ?1`,
  )
    .bind(c.req.param('ref'))
    .first<Pick<BookingRow, 'id' | 'ref' | 'status' | 'event_id' | 'party_size'>>();

  if (!booking) throw new ApiError(404, 'booking_not_found', 'No booking with that reference.');
  if (booking.status === 'cancelled' || booking.status === 'expired') {
    return c.json({ ok: true, alreadyInactive: true });
  }

  await c.env.DB.batch([
    releaseSpotsStmt(c.env.DB, booking.event_id, booking.party_size),
    c.env.DB.prepare(
      `UPDATE bookings
          SET status = 'cancelled', hold_expires_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1`,
    ).bind(booking.id),
  ]);

  // Any refund is initiated in Stripe; the charge.refunded webhook records it.
  return c.json({ ok: true, refundNote: 'Issue any refund from the Stripe dashboard.' });
});

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

/**
 * Finds a current signature belonging to this seat's player -- matched on the
 * player row, or failing that on the email the seat was booked under -- and
 * attaches it. Returns its expiry, or null if there is nothing to attach.
 *
 * Only ever fills a seat that has no waiver: an expired signature stays visible
 * as expired rather than being quietly swapped for a newer one.
 */
async function attachExistingWaiver(db: D1Database, attendeeId: number): Promise<string | null> {
  const candidate = await db
    .prepare(
      `SELECT w.id, w.expires_at
         FROM booking_attendees a
         JOIN waivers w
           ON (w.player_id IS NOT NULL AND w.player_id = a.player_id)
           OR (a.email IS NOT NULL AND lower(w.signer_email) = lower(a.email))
        WHERE a.id = ?1
          AND a.waiver_id IS NULL
          AND w.expires_at > ?2
        ORDER BY w.expires_at DESC
        LIMIT 1`,
    )
    .bind(attendeeId, nowIso())
    .first<{ id: number; expires_at: string }>();

  if (!candidate) return null;

  await db
    .prepare(`UPDATE booking_attendees SET waiver_id = ?1 WHERE id = ?2 AND waiver_id IS NULL`)
    .bind(candidate.id, attendeeId)
    .run();

  return candidate.expires_at;
}

admin.post('/attendees/:id/check-in', async (c) => {
  const attendeeId = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const chronoOk = 'chronoOk' in (body as object) ? requireBool(body, 'chronoOk') : false;

  const row = await c.env.DB.prepare(
    `SELECT a.id, a.checked_in_at, b.status AS booking_status,
            w.expires_at AS waiver_expires_at
       FROM booking_attendees a
       JOIN bookings b ON b.id = a.booking_id
       LEFT JOIN waivers w ON w.id = a.waiver_id
      WHERE a.id = ?1`,
  )
    .bind(attendeeId)
    .first<{
      id: number;
      checked_in_at: string | null;
      booking_status: string;
      waiver_expires_at: string | null;
    }>();

  if (!row) throw new ApiError(404, 'attendee_not_found', 'No such attendee.');

  if (row.booking_status === 'cancelled' || row.booking_status === 'expired') {
    throw new ApiError(409, 'booking_inactive', 'That booking is cancelled or expired.');
  }

  // This seat may have no waiver attached only because the player signed the
  // standalone waiver before the booking existed. That is a signature on file,
  // so look for it by identity before turning them away -- and attach it, so
  // the roster stops showing them as unsigned.
  if (!row.waiver_expires_at) {
    row.waiver_expires_at = await attachExistingWaiver(c.env.DB, attendeeId);
  }

  // The rule this whole system exists to enforce: nobody steps on the field
  // without a current signed waiver.
  if (!row.waiver_expires_at) {
    throw new ApiError(422, 'waiver_missing', 'This player has not signed a waiver.');
  }
  if (row.waiver_expires_at <= nowIso()) {
    throw new ApiError(422, 'waiver_expired', 'This player’s waiver has expired and must be re-signed.');
  }

  await c.env.DB.prepare(
    `UPDATE booking_attendees
        SET checked_in_at = COALESCE(checked_in_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            chrono_ok = ?1
      WHERE id = ?2`,
  )
    .bind(chronoOk ? 1 : 0, attendeeId)
    .run();

  return c.json({ ok: true, alreadyCheckedIn: row.checked_in_at !== null });
});

admin.post('/attendees/:id/undo-check-in', async (c) => {
  const result = await c.env.DB.prepare(
    `UPDATE booking_attendees SET checked_in_at = NULL, chrono_ok = 0 WHERE id = ?1`,
  )
    .bind(Number(c.req.param('id')))
    .run();
  if (result.meta.changes === 0) throw new ApiError(404, 'attendee_not_found', 'No such attendee.');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Waiver versions
// ---------------------------------------------------------------------------

admin.get('/waiver-versions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, version, body_sha256, effective_from, active,
            (SELECT COUNT(*) FROM waivers w WHERE w.waiver_version_id = v.id) AS signatures
       FROM waiver_versions v
      ORDER BY id DESC`,
  ).all();
  return c.json({ versions: results });
});

/**
 * Publishes new waiver wording. Previous versions are kept, not edited --
 * signatures already collected must keep resolving to the text that was signed.
 */
admin.post('/waiver-versions', async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  const version = requireString(body, 'version', 60);
  const text = requireString(body, 'body', 60_000);
  const hash = await sha256Hex(text);

  const exists = await c.env.DB.prepare(`SELECT id FROM waiver_versions WHERE version = ?1`)
    .bind(version)
    .first();
  if (exists) throw new ApiError(409, 'version_exists', 'That version label is already used.');

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE waiver_versions SET active = 0 WHERE active = 1`),
    c.env.DB.prepare(
      `INSERT INTO waiver_versions (version, body, body_sha256, active) VALUES (?1, ?2, ?3, 1)`,
    ).bind(version, text, hash),
  ]);

  return c.json({ version, sha256: hash, active: true }, 201);
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Same job the cron runs; exposed so staff can force it while watching a sell-out. */
admin.post('/sweep-holds', async (c) => {
  const released = await sweepExpiredHolds(c.env);
  return c.json({ released });
});
