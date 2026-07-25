import type { Env } from './types';
import { ApiError } from './validate';
import { timingSafeEqual } from './db';

/**
 * A very small Stripe client.
 *
 * We call the REST API with fetch rather than pulling in the Node SDK: the only
 * things needed are "create a Checkout Session" and "verify a webhook
 * signature", both of which are a few lines here, and it keeps the Worker free
 * of Node compatibility shims.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * True when no Stripe key is configured. In that mode checkout is simulated
 * locally so the whole booking -> paid -> check-in path can be exercised
 * offline. Any deployment with a real key never takes these branches.
 */
export const isStripeConfigured = (env: Env) => Boolean(env.STRIPE_SECRET_KEY?.trim());

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: string;
}

export interface CheckoutParams {
  bookingRef: string;
  unitAmountCents: number;
  quantity: number;
  currency: string;
  productName: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** Minutes until the session expires. Stripe requires at least 30. */
  expiresInMinutes: number;
}

export async function createCheckoutSession(
  env: Env,
  params: CheckoutParams,
): Promise<CheckoutSession> {
  const minutes = Math.max(30, Math.min(params.expiresInMinutes, 24 * 60));
  const expiresAtMs = Date.now() + minutes * 60_000;

  if (!isStripeConfigured(env)) {
    // Offline stub -- see src/routes/checkout.ts for the simulated payment page.
    return {
      id: `cs_dev_${params.bookingRef}`,
      url: `/api/dev/checkout?ref=${encodeURIComponent(params.bookingRef)}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('client_reference_id', params.bookingRef);
  form.set('metadata[booking_ref]', params.bookingRef);
  form.set('customer_email', params.customerEmail);
  form.set('success_url', params.successUrl);
  form.set('cancel_url', params.cancelUrl);
  form.set('expires_at', String(Math.floor(expiresAtMs / 1000)));
  form.set('line_items[0][quantity]', String(params.quantity));
  form.set('line_items[0][price_data][currency]', params.currency);
  form.set('line_items[0][price_data][unit_amount]', String(params.unitAmountCents));
  form.set('line_items[0][price_data][product_data][name]', params.productName);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Retrying a create for the same booking returns the same session
      // instead of a second one.
      'Idempotency-Key': `checkout_${params.bookingRef}`,
    },
    body: form,
  });

  const payload = (await res.json()) as {
    id?: string;
    url?: string;
    expires_at?: number;
    error?: { message?: string };
  };

  if (!res.ok || !payload.id || !payload.url) {
    console.error('stripe: checkout session failed', res.status, payload.error?.message);
    throw new ApiError(502, 'stripe_error', 'Could not start checkout. Please try again.');
  }

  return {
    id: payload.id,
    url: payload.url,
    expiresAt: new Date((payload.expires_at ?? Math.floor(expiresAtMs / 1000)) * 1000).toISOString(),
  };
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/**
 * Verifies Stripe's `Stripe-Signature` header against the raw request body.
 *
 * The body must be the exact bytes Stripe sent -- re-serialised JSON will not
 * match, which is why the caller passes the raw text.
 */
export async function verifyWebhook(
  env: Env,
  rawBody: string,
  signatureHeader: string | undefined,
  toleranceSeconds = 300,
): Promise<StripeEvent> {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!secret) {
    // Only tolerated in the fully-unconfigured local mode. If a real Stripe key
    // is present, a missing webhook secret is a misconfiguration, not a licence
    // to accept unsigned events.
    if (isStripeConfigured(env)) {
      throw new ApiError(
        500,
        'webhook_not_configured',
        'STRIPE_WEBHOOK_SECRET is not set on this deployment.',
      );
    }
    return JSON.parse(rawBody) as StripeEvent;
  }

  if (!signatureHeader) {
    throw new ApiError(400, 'signature_missing', 'Missing Stripe-Signature header.');
  }

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k?.trim() === 't') timestamp = v ?? '';
    if (k?.trim() === 'v1' && v) signatures.push(v);
  }

  if (!timestamp || signatures.length === 0) {
    throw new ApiError(400, 'signature_malformed', 'Malformed Stripe-Signature header.');
  }

  // Replay window. Without this a captured request stays valid forever.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    throw new ApiError(400, 'signature_expired', 'Stripe signature timestamp is outside tolerance.');
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((sig) => timingSafeEqual(sig, expected))) {
    throw new ApiError(400, 'signature_invalid', 'Stripe signature did not verify.');
  }

  return JSON.parse(rawBody) as StripeEvent;
}
