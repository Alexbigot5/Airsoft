import type { Env, WaiverVersionRow } from './types';

export const nowIso = () => new Date().toISOString();

export const addMinutes = (iso: string, minutes: number) =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Age in whole years on a given date. Used to decide whether a signer is a
 * minor, which is why it is computed here from the date of birth rather than
 * trusted from the client.
 */
export function ageOn(dateOfBirth: string, on: string): number {
  const dob = new Date(`${dateOfBirth}T00:00:00.000Z`);
  const at = new Date(on);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 -- these get read aloud

function randomFrom(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** Human-quotable booking reference, e.g. CR-7QK4M2. */
export const newBookingRef = () => `CR-${randomFrom(ALPHABET, 6)}`;

/**
 * Per-attendee waiver token. This is the only thing protecting a waiver link,
 * so it is 32 chars of CSPRNG hex rather than the friendly alphabet above.
 */
export const newAttendeeToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent constant-time compare for tokens and signatures. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Compare lengths without an early return so the timing does not leak it.
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function activeWaiverVersion(env: Env): Promise<WaiverVersionRow> {
  const row = await env.DB.prepare(
    `SELECT id, version, body, body_sha256, active
       FROM waiver_versions
      WHERE active = 1
      LIMIT 1`,
  ).first<WaiverVersionRow>();
  if (!row) throw new Error('No active waiver version. Run the seed migrations.');
  return row;
}

export const holdMinutes = (env: Env) => Number(env.HOLD_MINUTES ?? '30') || 30;
export const waiverValidDays = (env: Env) => Number(env.WAIVER_VALID_DAYS ?? '365') || 365;

/**
 * Base URL used to build links that leave the app (Stripe redirects, waiver
 * links).
 *
 * Defaults to the origin of the incoming request, which is right for local dev,
 * workers.dev and preview deployments alike. PUBLIC_BASE_URL only needs setting
 * when the canonical origin differs from the one being served -- a config left
 * pointing at localhost is a worse failure than having no config at all.
 */
export function baseUrl(env: Env, req: Request): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  return configured ? configured.replace(/\/$/, '') : new URL(req.url).origin;
}
