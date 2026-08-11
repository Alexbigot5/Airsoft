export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  PUBLIC_BASE_URL: string;
  WAIVER_VALID_DAYS: string;
  HOLD_MINUTES: string;
  CONTACT_EMAIL?: string;
  CONTACT_FROM?: string;

  // secrets (wrangler secret put / .dev.vars)
  ADMIN_TOKEN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
}

export type AppBindings = { Bindings: Env };

export type BookingStatus = 'pending_payment' | 'paid' | 'cancelled' | 'expired';

export interface EventRow {
  id: number;
  slug: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  mode: string | null;
  field: string;
  level: string;
  capacity: number;
  spots_taken: number;
  base_price_cents: number;
  note: string | null;
  status: string;
}

export interface PackageRow {
  id: string;
  name: string;
  blurb: string | null;
  price_cents: number;
  includes_json: string;
  active: number;
  sort_order: number;
}

export interface BookingRow {
  id: number;
  ref: string;
  event_id: number;
  package_id: string;
  player_id: number;
  party_size: number;
  amount_cents: number;
  currency: string;
  status: BookingStatus;
  hold_expires_at: string | null;
  overbooked: number;
  stripe_session_id: string | null;
  stripe_session_expires_at: string | null;
  stripe_payment_intent: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface AttendeeRow {
  id: number;
  booking_id: number;
  seat_no: number;
  attendee_token: string;
  player_id: number | null;
  full_name: string | null;
  email: string | null;
  date_of_birth: string | null;
  is_minor: number | null;
  waiver_id: number | null;
  checked_in_at: string | null;
  chrono_ok: number;
}

export interface ContactMessageRow {
  id: number;
  name: string;
  email: string;
  message: string;
  ip: string | null;
  emailed: number;
  error: string | null;
  created_at: string;
}

export interface WaiverVersionRow {
  id: number;
  version: string;
  body: string;
  body_sha256: string;
  active: number;
}
