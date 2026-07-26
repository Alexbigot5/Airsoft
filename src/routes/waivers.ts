import { Hono } from 'hono';
import type { AppBindings, AttendeeRow, WaiverVersionRow } from '../types';
import {
  ApiError,
  optionalString,
  requireDateOnly,
  requireEmail,
  requireString,
  field,
} from '../validate';
import { activeWaiverVersion, addDays, ageOn, nowIso, waiverValidDays } from '../db';

export const waivers = new Hono<AppBindings>();

/** Minimum age to set foot on the field at all, per the posted rules. */
const MINIMUM_AGE = 12;
/** At or above this age a participant signs for themselves. */
const ADULT_AGE = 18;

waivers.get('/waiver/current', async (c) => {
  const version = await activeWaiverVersion(c.env);
  return c.json({
    version: version.version,
    body: version.body,
    sha256: version.body_sha256,
    minimumAge: MINIMUM_AGE,
    adultAge: ADULT_AGE,
  });
});

/**
 * Everything a signature needs, validated. Shared by both ways in: the
 * per-attendee link that comes with a booking, and the standalone waiver page
 * anyone can sign before they turn up.
 *
 * `ageAt` is the date the signer's age is judged against -- the game day for an
 * attendee, the moment of signing for a standalone waiver. Age is always
 * recomputed here from the date of birth; nothing the client claims about it is
 * read.
 */
interface Signature {
  signerName: string;
  signerEmail: string;
  dateOfBirth: string;
  isMinor: boolean;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianRelationship: string | null;
  emergencyName: string;
  emergencyPhone: string;
}

function readSignature(body: unknown, version: WaiverVersionRow, ageAt: string): Signature {
  // The signer must be agreeing to the text that was actually on their screen.
  // If the wording was republished while the page sat open, make them re-read it.
  const acceptedSha = requireString(body, 'acceptedSha256', 64);
  if (acceptedSha !== version.body_sha256) {
    throw new ApiError(
      409,
      'waiver_version_stale',
      'The waiver was updated while this page was open. Please reload and read the current version.',
    );
  }
  if (field(body, 'agreed') !== true) {
    throw new ApiError(400, 'not_agreed', 'You must confirm that you agree to the waiver.');
  }

  const signerName = requireString(body, 'signerName', 120);
  const dateOfBirth = requireDateOnly(body, 'dateOfBirth');
  const signerEmail = requireEmail(body, 'email');

  const age = ageOn(dateOfBirth, ageAt);
  if (age < 0 || age > 120) {
    throw new ApiError(400, 'invalid_date', 'That date of birth does not look right.');
  }
  if (age < MINIMUM_AGE) {
    throw new ApiError(
      422,
      'too_young',
      `Players must be at least ${MINIMUM_AGE} years old on the day of the game.`,
    );
  }
  const isMinor = age < ADULT_AGE;

  let guardianName: string | null = null;
  let guardianEmail: string | null = null;
  let guardianPhone: string | null = null;
  let guardianRelationship: string | null = null;

  if (isMinor) {
    const guardian = field(body, 'guardian');
    if (typeof guardian !== 'object' || guardian === null) {
      throw new ApiError(
        422,
        'guardian_required',
        'Players under 18 need a parent or legal guardian to sign for them.',
      );
    }
    guardianName = requireString(guardian, 'name', 120);
    guardianEmail = requireEmail(guardian, 'email');
    guardianPhone = requireString(guardian, 'phone', 40);
    guardianRelationship = requireString(guardian, 'relationship', 60);
  }

  const emergency = field(body, 'emergencyContact');
  const emergencyName = emergency ? optionalString(emergency, 'name', 120) : null;
  const emergencyPhone = emergency ? optionalString(emergency, 'phone', 40) : null;
  if (!emergencyName || !emergencyPhone) {
    throw new ApiError(
      422,
      'emergency_contact_required',
      'An emergency contact name and phone number are required.',
    );
  }

  return {
    signerName,
    signerEmail,
    dateOfBirth,
    isMinor,
    guardianName,
    guardianEmail,
    guardianPhone,
    guardianRelationship,
    emergencyName,
    emergencyPhone,
  };
}

/** Writes the signature row. Append-only -- there is no update path. */
async function recordSignature(
  db: D1Database,
  version: WaiverVersionRow,
  signature: Signature,
  playerId: number | null,
  signedAt: string,
  expiresAt: string,
  ip: string | null,
  userAgent: string | null,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO waivers (waiver_version_id, body_sha256, player_id, signer_name, signer_email,
                            date_of_birth, is_minor, guardian_name, guardian_email, guardian_phone,
                            guardian_relationship, emergency_contact_name, emergency_contact_phone,
                            signed_at, expires_at, ip, user_agent)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         RETURNING id`,
    )
    .bind(
      version.id,
      version.body_sha256,
      playerId,
      signature.signerName,
      signature.signerEmail,
      signature.dateOfBirth,
      signature.isMinor ? 1 : 0,
      signature.guardianName,
      signature.guardianEmail,
      signature.guardianPhone,
      signature.guardianRelationship,
      signature.emergencyName,
      signature.emergencyPhone,
      signedAt,
      expiresAt,
      ip,
      userAgent,
    )
    .first<{ id: number }>();

  if (!row) throw new ApiError(500, 'waiver_insert_failed', 'Could not record the signature.');
  return row.id;
}

type AttendeeContext = AttendeeRow & {
  booking_ref: string;
  booking_status: string;
  event_title: string;
  event_starts_at: string;
  waiver_expires_at: string | null;
};

async function loadAttendee(db: D1Database, token: string): Promise<AttendeeContext> {
  const row = await db
    .prepare(
      `SELECT a.id, a.booking_id, a.seat_no, a.attendee_token, a.player_id, a.full_name,
              a.email, a.date_of_birth, a.is_minor, a.waiver_id, a.checked_in_at, a.chrono_ok,
              b.ref AS booking_ref, b.status AS booking_status,
              e.title AS event_title, e.starts_at AS event_starts_at,
              w.expires_at AS waiver_expires_at
         FROM booking_attendees a
         JOIN bookings b ON b.id = a.booking_id
         JOIN events e ON e.id = b.event_id
         LEFT JOIN waivers w ON w.id = a.waiver_id
        WHERE a.attendee_token = ?1`,
    )
    .bind(token)
    .first<AttendeeContext>();

  if (!row) throw new ApiError(404, 'waiver_link_invalid', 'That waiver link is not valid.');
  return row;
}

waivers.get('/waiver/attendee/:token', async (c) => {
  const attendee = await loadAttendee(c.env.DB, c.req.param('token'));
  const version = await activeWaiverVersion(c.env);
  const signedAndValid =
    attendee.waiver_id !== null && (attendee.waiver_expires_at ?? '') > nowIso();

  return c.json({
    bookingRef: attendee.booking_ref,
    bookingStatus: attendee.booking_status,
    seatNo: attendee.seat_no,
    event: { title: attendee.event_title, startsAt: attendee.event_starts_at },
    name: attendee.full_name,
    email: attendee.email,
    alreadySigned: signedAndValid,
    waiverExpiresAt: attendee.waiver_expires_at,
    waiver: {
      version: version.version,
      body: version.body,
      sha256: version.body_sha256,
      minimumAge: MINIMUM_AGE,
      adultAge: ADULT_AGE,
    },
  });
});

waivers.post('/waiver/attendee/:token', async (c) => {
  const attendee = await loadAttendee(c.env.DB, c.req.param('token'));

  if (attendee.waiver_id !== null && (attendee.waiver_expires_at ?? '') > nowIso()) {
    throw new ApiError(409, 'already_signed', 'This attendee already has a valid waiver on file.');
  }
  if (attendee.booking_status === 'cancelled' || attendee.booking_status === 'expired') {
    throw new ApiError(409, 'booking_inactive', 'That booking is no longer active.');
  }

  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  const version = await activeWaiverVersion(c.env);

  // Age is judged against the day they will actually play.
  const signature = readSignature(body, version, attendee.event_starts_at);

  const signedAt = nowIso();
  const expiresAt = addDays(signedAt, waiverValidDays(c.env));

  const waiverId = await recordSignature(
    c.env.DB,
    version,
    signature,
    attendee.player_id,
    signedAt,
    expiresAt,
    c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for') ?? null,
    c.req.header('User-Agent') ?? null,
  );

  await c.env.DB.prepare(
    `UPDATE booking_attendees
        SET waiver_id     = ?1,
            full_name     = COALESCE(full_name, ?2),
            email         = COALESCE(email, ?3),
            date_of_birth = ?4,
            is_minor      = ?5
      WHERE id = ?6`,
  )
    .bind(
      waiverId,
      signature.signerName,
      signature.signerEmail,
      signature.dateOfBirth,
      signature.isMinor ? 1 : 0,
      attendee.id,
    )
    .run();

  return c.json(
    {
      waiverId,
      version: version.version,
      signedAt,
      expiresAt,
      isMinor: signature.isMinor,
      bookingRef: attendee.booking_ref,
    },
    201,
  );
});

/**
 * The standalone waiver, linked from the marketing site's Games page: sign
 * before you turn up, with or without a booking.
 *
 * Two things make this more than a second copy of the route above:
 *
 *  - There is no game day to judge age against, so age is taken at the moment
 *    of signing. Someone who is 11 today cannot sign ahead for the weekend they
 *    turn 12; they sign on the day instead.
 *  - The signature has to find its way onto the roster, or staff would refuse
 *    entry to somebody who did exactly what the page told them to. It is
 *    attached to the player (by email, the same identity bookings use) and
 *    linked to any attendee seat that is booked under that address and does not
 *    already hold a valid waiver.
 */
waivers.post('/waiver/sign', async (c) => {
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON.');
  });

  const version = await activeWaiverVersion(c.env);
  const signedAt = nowIso();
  const signature = readSignature(body, version, signedAt);

  // A refreshed page or a double tap should not stack up identical signatures.
  // A *different* name or date of birth is a correction, and does get its own
  // row -- waivers are append-only, so that is how corrections are made.
  const existing = await c.env.DB.prepare(
    `SELECT id, signed_at, expires_at, is_minor
       FROM waivers
      WHERE signer_email = ?1
        AND lower(signer_name) = lower(?2)
        AND date_of_birth = ?3
        AND expires_at > ?4
      ORDER BY expires_at DESC
      LIMIT 1`,
  )
    .bind(signature.signerEmail, signature.signerName, signature.dateOfBirth, signedAt)
    .first<{ id: number; signed_at: string; expires_at: string; is_minor: number }>();

  if (existing) {
    return c.json({
      waiverId: existing.id,
      version: version.version,
      signedAt: existing.signed_at,
      expiresAt: existing.expires_at,
      isMinor: existing.is_minor === 1,
      alreadySigned: true,
      linkedAttendees: 0,
    });
  }

  // Email is identity here exactly as it is for bookings, so a waiver signed in
  // advance and a booking made later land on the same player row.
  const player = await c.env.DB.prepare(
    `INSERT INTO players (email, full_name, date_of_birth)
          VALUES (?1, ?2, ?3)
     ON CONFLICT (email) DO UPDATE
            SET full_name     = excluded.full_name,
                date_of_birth = excluded.date_of_birth,
                updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING id, blacklisted`,
  )
    .bind(signature.signerEmail, signature.signerName, signature.dateOfBirth)
    .first<{ id: number; blacklisted: number }>();

  if (!player) throw new ApiError(500, 'player_upsert_failed', 'Could not record the player.');
  if (player.blacklisted) {
    throw new ApiError(403, 'player_blocked', 'This account cannot play. Please contact the field.');
  }

  const expiresAt = addDays(signedAt, waiverValidDays(c.env));
  const waiverId = await recordSignature(
    c.env.DB,
    version,
    signature,
    player.id,
    signedAt,
    expiresAt,
    c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for') ?? null,
    c.req.header('User-Agent') ?? null,
  );

  const linked = await c.env.DB.prepare(
    `UPDATE booking_attendees
        SET waiver_id     = ?1,
            player_id     = COALESCE(player_id, ?2),
            date_of_birth = ?3,
            is_minor      = ?4
      WHERE lower(email) = ?5
        AND booking_id IN (SELECT id FROM bookings WHERE status IN ('pending_payment', 'paid'))
        AND (waiver_id IS NULL
             OR waiver_id IN (SELECT id FROM waivers WHERE expires_at <= ?6))`,
  )
    .bind(
      waiverId,
      player.id,
      signature.dateOfBirth,
      signature.isMinor ? 1 : 0,
      signature.signerEmail,
      signedAt,
    )
    .run();

  return c.json(
    {
      waiverId,
      version: version.version,
      signedAt,
      expiresAt,
      isMinor: signature.isMinor,
      alreadySigned: false,
      linkedAttendees: linked.meta.changes,
    },
    201,
  );
});
