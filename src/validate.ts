import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An error with an HTTP status and a stable machine-readable code. Thrown from
 * anywhere; the app's onError turns it into `{ error: { code, message } }`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('invalid_body', 'Expected a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function field(body: unknown, name: string): unknown {
  return asRecord(body)[name];
}

export function requireString(body: unknown, name: string, max = 200): string {
  const raw = asRecord(body)[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw badRequest('missing_field', `"${name}" is required.`);
  }
  const value = raw.trim();
  if (value.length > max) {
    throw badRequest('field_too_long', `"${name}" must be ${max} characters or fewer.`);
  }
  return value;
}

export function optionalString(body: unknown, name: string, max = 200): string | null {
  const raw = asRecord(body)[name];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw badRequest('invalid_field', `"${name}" must be a string.`);
  }
  const value = raw.trim();
  if (value.length > max) {
    throw badRequest('field_too_long', `"${name}" must be ${max} characters or fewer.`);
  }
  return value;
}

export function requireInt(body: unknown, name: string, min: number, max: number): number {
  const raw = asRecord(body)[name];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest('invalid_field', `"${name}" must be a whole number.`);
  }
  if (value < min || value > max) {
    throw badRequest('out_of_range', `"${name}" must be between ${min} and ${max}.`);
  }
  return value;
}

export function requireBool(body: unknown, name: string): boolean {
  const raw = asRecord(body)[name];
  if (typeof raw !== 'boolean') {
    throw badRequest('invalid_field', `"${name}" must be true or false.`);
  }
  return raw;
}

/**
 * Deliberately permissive. The point is to catch typos and obvious junk, not to
 * adjudicate RFC 5322 -- the only real proof an address works is mail arriving.
 */
export function requireEmail(body: unknown, name = 'email'): string {
  const value = requireString(body, name, 254).toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(value)) {
    throw badRequest('invalid_email', 'That does not look like an email address.');
  }
  return value;
}

/** Requires a real calendar date in YYYY-MM-DD form, not just the right shape. */
export function requireDateOnly(body: unknown, name: string): string {
  const value = requireString(body, name, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw badRequest('invalid_date', `"${name}" must be a date in YYYY-MM-DD form.`);
  }
  const [, y, m, d] = match;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() + 1 !== Number(m) ||
    date.getUTCDate() !== Number(d)
  ) {
    throw badRequest('invalid_date', `"${name}" is not a real date.`);
  }
  return value;
}
