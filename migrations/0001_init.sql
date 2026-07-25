-- Coyote Ridge Airsoft -- initial schema.
--
-- Conventions used throughout:
--   * timestamps are ISO-8601 UTC strings ('2026-07-25T06:00:00.000Z')
--   * money is integer cents, never a float
--   * booleans are INTEGER 0/1

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- packages: what you can buy for a game day (walk-on, half day, ...)
-- ---------------------------------------------------------------------------
CREATE TABLE packages (
  id            TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,
  blurb         TEXT,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  includes_json TEXT    NOT NULL DEFAULT '[]',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- events: a scheduled game day.
--
-- spots_taken is the single source of truth for capacity. Remaining spots are
-- always derived (capacity - spots_taken) so the two can never disagree, and
-- the CHECK below is the last line of defence against overselling.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  starts_at        TEXT    NOT NULL,
  ends_at          TEXT,
  mode             TEXT,
  field            TEXT    NOT NULL DEFAULT 'woodland',
  level            TEXT    NOT NULL DEFAULT 'All levels',
  capacity         INTEGER NOT NULL CHECK (capacity >= 0),
  spots_taken      INTEGER NOT NULL DEFAULT 0,
  base_price_cents INTEGER NOT NULL DEFAULT 3500,
  note             TEXT,
  status           TEXT    NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (spots_taken >= 0 AND spots_taken <= capacity)
);

CREATE INDEX idx_events_starts_at ON events (starts_at);
CREATE INDEX idx_events_status ON events (status, starts_at);

-- ---------------------------------------------------------------------------
-- players: identified by email. No passwords, no login -- a walk-on field does
-- not need accounts, and not storing credentials is one less thing to leak.
-- ---------------------------------------------------------------------------
CREATE TABLE players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,   -- always stored lowercased
  full_name     TEXT    NOT NULL,
  phone         TEXT,
  date_of_birth TEXT,
  callsign      TEXT,
  notes         TEXT,
  blacklisted   INTEGER NOT NULL DEFAULT 0 CHECK (blacklisted IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- waiver_versions: the waiver text lives in the database, not in code, so a
-- signature from last season still resolves to exactly what was on screen.
-- ---------------------------------------------------------------------------
CREATE TABLE waiver_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version        TEXT    NOT NULL UNIQUE,
  body           TEXT    NOT NULL,
  body_sha256    TEXT    NOT NULL,
  effective_from TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  active         INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

-- At most one active waiver version at a time.
CREATE UNIQUE INDEX idx_waiver_versions_active
  ON waiver_versions (active) WHERE active = 1;

-- ---------------------------------------------------------------------------
-- waivers: the signature record. Append-only -- the API never updates or
-- deletes a row here. A correction is a new signature.
-- ---------------------------------------------------------------------------
CREATE TABLE waivers (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  waiver_version_id       INTEGER NOT NULL REFERENCES waiver_versions (id),
  -- Denormalised on purpose: proves what was on screen independently of the
  -- waiver_versions row, which could in principle be edited later.
  body_sha256             TEXT    NOT NULL,
  player_id               INTEGER REFERENCES players (id),
  signer_name             TEXT    NOT NULL,
  signer_email            TEXT,
  date_of_birth           TEXT    NOT NULL,
  is_minor                INTEGER NOT NULL CHECK (is_minor IN (0, 1)),
  guardian_name           TEXT,
  guardian_email          TEXT,
  guardian_phone          TEXT,
  guardian_relationship   TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  signed_at               TEXT    NOT NULL,
  expires_at              TEXT    NOT NULL,
  ip                      TEXT,
  user_agent              TEXT,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A minor can never self-sign.
  CHECK (is_minor = 0 OR (guardian_name IS NOT NULL AND trim(guardian_name) <> ''))
);

CREATE INDEX idx_waivers_player ON waivers (player_id, expires_at);
CREATE INDEX idx_waivers_email ON waivers (signer_email, expires_at);

-- ---------------------------------------------------------------------------
-- bookings: one booking covers a party of N players.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                   TEXT    NOT NULL UNIQUE,
  event_id              INTEGER NOT NULL REFERENCES events (id),
  package_id            TEXT    NOT NULL REFERENCES packages (id),
  player_id             INTEGER NOT NULL REFERENCES players (id),
  party_size            INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 20),
  amount_cents          INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency              TEXT    NOT NULL DEFAULT 'usd',
  status                TEXT    NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('pending_payment', 'paid', 'cancelled', 'expired')),
  -- Set while the booking holds spots without having paid; NULL once settled.
  hold_expires_at       TEXT,
  -- Set when a payment landed after the hold was swept and the event had since
  -- filled up. Surfaced to staff rather than silently overselling.
  overbooked            INTEGER NOT NULL DEFAULT 0 CHECK (overbooked IN (0, 1)),
  stripe_session_id     TEXT,
  stripe_session_expires_at TEXT,
  stripe_payment_intent TEXT,
  paid_at               TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bookings_event ON bookings (event_id, status);
CREATE INDEX idx_bookings_player ON bookings (player_id);
CREATE INDEX idx_bookings_sweep ON bookings (status, hold_expires_at);
CREATE INDEX idx_bookings_session ON bookings (stripe_session_id);

-- ---------------------------------------------------------------------------
-- booking_attendees: one row per person in the party.
--
-- Waivers are per attendee, not per booking -- everyone who steps on the field
-- signs for themselves. Each row carries an unguessable token so a squad mate
-- can sign their own waiver without being shown the whole booking.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_attendees (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     INTEGER NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seat_no        INTEGER NOT NULL,
  attendee_token TEXT    NOT NULL UNIQUE,
  player_id      INTEGER REFERENCES players (id),
  full_name      TEXT,
  email          TEXT,
  date_of_birth  TEXT,
  is_minor       INTEGER,
  waiver_id      INTEGER REFERENCES waivers (id),
  checked_in_at  TEXT,
  chrono_ok      INTEGER NOT NULL DEFAULT 0 CHECK (chrono_ok IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (booking_id, seat_no)
);

CREATE INDEX idx_attendees_booking ON booking_attendees (booking_id);
CREATE INDEX idx_attendees_token ON booking_attendees (attendee_token);

-- ---------------------------------------------------------------------------
-- payments: what actually moved, as reported by the processor.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id            INTEGER NOT NULL REFERENCES bookings (id),
  provider              TEXT    NOT NULL DEFAULT 'stripe',
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT,
  amount_cents          INTEGER NOT NULL,
  currency              TEXT    NOT NULL DEFAULT 'usd',
  status                TEXT    NOT NULL
                        CHECK (status IN ('succeeded', 'failed', 'refunded', 'manual')),
  raw_json              TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_payments_booking ON payments (booking_id);

-- ---------------------------------------------------------------------------
-- webhook_events: idempotency guard. Stripe retries aggressively and will
-- happily deliver the same event more than once; the primary key is the whole
-- mechanism -- a duplicate insert means "already handled, stop here".
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  payload     TEXT
);
