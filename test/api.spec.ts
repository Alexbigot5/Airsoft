import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * These cover the rules that cost money or create liability if they are wrong:
 * capacity, pricing, who may sign, and who may step on the field. The happy
 * path is exercised by the manual runbook in the README.
 */

const ADMIN = { Authorization: 'Bearer test-staff-token' };
const JSON_HEADERS = { 'content-type': 'application/json' };

const future = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
};

let eventSeq = 0;

async function makeEvent(capacity: number, startsAt = future(7)) {
  const slug = `test-event-${++eventSeq}-${crypto.randomUUID().slice(0, 8)}`;
  const row = await env.DB.prepare(
    `INSERT INTO events (slug, title, starts_at, capacity, base_price_cents)
          VALUES (?1, 'Test Game Day', ?2, ?3, 3500)
       RETURNING id`,
  )
    .bind(slug, startsAt, capacity)
    .first<{ id: number }>();
  return { id: row!.id, slug };
}

async function book(slug: string, partySize: number, extra: Record<string, unknown> = {}) {
  const res = await SELF.fetch('https://x/api/bookings', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      eventSlug: slug,
      packageId: 'walkon',
      partySize,
      name: 'Test Player',
      email: `p${crypto.randomUUID().slice(0, 8)}@example.com`,
      ...extra,
    }),
  });
  return { res, body: (await res.json()) as any };
}

const currentSha = async () => {
  const res = await SELF.fetch('https://x/api/waiver/current');
  return ((await res.json()) as any).sha256 as string;
};

const spotsTaken = async (id: number) =>
  (await env.DB.prepare(`SELECT spots_taken FROM events WHERE id = ?1`).bind(id).first<{
    spots_taken: number;
  }>())!.spots_taken;

function signBody(overrides: Record<string, unknown>, sha: string) {
  return JSON.stringify({
    signerName: 'Adult Player',
    dateOfBirth: '1990-04-02',
    email: 'adult@example.com',
    agreed: true,
    acceptedSha256: sha,
    emergencyContact: { name: 'Sam Contact', phone: '555-0101' },
    ...overrides,
  });
}

describe('capacity', () => {
  it('never sells more spots than the event has', async () => {
    const event = await makeEvent(2);

    // Three single-spot bookings at once against two spots.
    const results = await Promise.all([book(event.slug, 1), book(event.slug, 1), book(event.slug, 1)]);
    const created = results.filter((r) => r.res.status === 201);
    const rejected = results.filter((r) => r.res.status === 409);

    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.error.code).toBe('sold_out');
    expect(await spotsTaken(event.id)).toBe(2);
  });

  it('rejects a party that does not fit rather than partially booking it', async () => {
    const event = await makeEvent(3);
    const { res, body } = await book(event.slug, 4);

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('sold_out');
    expect(await spotsTaken(event.id)).toBe(0);
  });

  it('refuses bookings for a game day that has already started', async () => {
    const event = await makeEvent(10, future(-1));
    const { res, body } = await book(event.slug, 1);

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('event_past');
  });
});

describe('pricing', () => {
  it('computes the amount server-side and ignores what the client sends', async () => {
    const event = await makeEvent(10);
    const { res, body } = await book(event.slug, 3, {
      amountCents: 1, // a tampered client total
      total: 1,
    });

    expect(res.status).toBe(201);
    expect(body.amountCents).toBe(3500 * 3); // walk-on price from the seed data
  });
});

describe('waivers', () => {
  it('refuses a signature made against stale waiver text', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);

    const res = await SELF.fetch(`https://x/api/waiver/attendee/${body.attendees[0].token}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: signBody({}, 'not-the-current-hash'),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('waiver_version_stale');
  });

  it('refuses to let a minor sign for themselves', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const sha = await currentSha();

    const res = await SELF.fetch(`https://x/api/waiver/attendee/${body.attendees[0].token}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: signBody({ signerName: 'Young Player', dateOfBirth: future(-14 * 365).slice(0, 10) }, sha),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.code).toBe('guardian_required');
  });

  it('accepts a minor when a guardian signs, and records them as a minor', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const sha = await currentSha();

    const res = await SELF.fetch(`https://x/api/waiver/attendee/${body.attendees[0].token}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: signBody(
        {
          signerName: 'Young Player',
          dateOfBirth: future(-14 * 365).slice(0, 10),
          guardian: {
            name: 'Parent Person',
            email: 'parent@example.com',
            phone: '555-0100',
            relationship: 'Parent',
          },
        },
        sha,
      ),
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as any).isMinor).toBe(true);
  });

  it('turns away anyone below the minimum age entirely', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const sha = await currentSha();

    const res = await SELF.fetch(`https://x/api/waiver/attendee/${body.attendees[0].token}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: signBody(
        {
          signerName: 'Far Too Young',
          dateOfBirth: future(-6 * 365).slice(0, 10),
          guardian: {
            name: 'Parent Person',
            email: 'parent@example.com',
            phone: '555-0100',
            relationship: 'Parent',
          },
        },
        sha,
      ),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.code).toBe('too_young');
  });

  it('stores the signature as evidence: version hash, timestamp and user agent', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const sha = await currentSha();

    await SELF.fetch(`https://x/api/waiver/attendee/${body.attendees[0].token}`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'User-Agent': 'test-agent/1.0' },
      body: signBody({}, sha),
    });

    const row = await env.DB.prepare(
      `SELECT w.body_sha256, w.user_agent, w.signed_at, w.expires_at
         FROM waivers w
         JOIN booking_attendees a ON a.waiver_id = w.id
        WHERE a.attendee_token = ?1`,
    )
      .bind(body.attendees[0].token)
      .first<{ body_sha256: string; user_agent: string; signed_at: string; expires_at: string }>();

    expect(row?.body_sha256).toBe(sha);
    expect(row?.user_agent).toBe('test-agent/1.0');
    expect(row!.expires_at > row!.signed_at).toBe(true);
  });
});

describe('standalone waiver', () => {
  const sign = async (overrides: Record<string, unknown>, sha?: string) =>
    SELF.fetch('https://x/api/waiver/sign', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: signBody(overrides, sha ?? (await currentSha())),
    });

  it('refuses a signature made against stale waiver text', async () => {
    const res = await sign({ email: `solo${crypto.randomUUID().slice(0, 8)}@example.com` }, 'nope');

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('waiver_version_stale');
  });

  it('refuses to let a minor sign for themselves', async () => {
    const res = await sign({
      signerName: 'Young Player',
      email: `young${crypto.randomUUID().slice(0, 8)}@example.com`,
      dateOfBirth: future(-14 * 365).slice(0, 10),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.code).toBe('guardian_required');
  });

  it('turns away anyone below the minimum age entirely', async () => {
    const res = await sign({
      signerName: 'Far Too Young',
      email: `tiny${crypto.randomUUID().slice(0, 8)}@example.com`,
      dateOfBirth: future(-6 * 365).slice(0, 10),
      guardian: {
        name: 'Parent Person',
        email: 'parent@example.com',
        phone: '555-0100',
        relationship: 'Parent',
      },
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.code).toBe('too_young');
  });

  it('files the signature against the player and returns it again on a resubmit', async () => {
    const email = `repeat${crypto.randomUUID().slice(0, 8)}@example.com`;
    const sha = await currentSha();

    const first = await sign({ signerName: 'Repeat Player', email }, sha);
    expect(first.status).toBe(201);
    const created = (await first.json()) as any;
    expect(created.alreadySigned).toBe(false);

    const second = await sign({ signerName: 'Repeat Player', email }, sha);
    expect(second.status).toBe(200);
    const again = (await second.json()) as any;
    expect(again.alreadySigned).toBe(true);
    expect(again.waiverId).toBe(created.waiverId);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM waivers w
         JOIN players p ON p.id = w.player_id
        WHERE w.signer_email = ?1 AND p.email = ?1`,
    )
      .bind(email)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('attaches to a seat already booked under the same email', async () => {
    const event = await makeEvent(5);
    const email = `booked${crypto.randomUUID().slice(0, 8)}@example.com`;
    const { body } = await book(event.slug, 1, { email });

    const res = await sign({ signerName: 'Booked Player', email });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).linkedAttendees).toBe(1);

    const attendee = await env.DB.prepare(
      `SELECT id, waiver_id FROM booking_attendees WHERE attendee_token = ?1`,
    )
      .bind(body.attendees[0].token)
      .first<{ id: number; waiver_id: number | null }>();
    expect(attendee?.waiver_id).not.toBeNull();

    const checkIn = await SELF.fetch(`https://x/api/admin/attendees/${attendee!.id}/check-in`, {
      method: 'POST',
      headers: { ...ADMIN, ...JSON_HEADERS },
      body: JSON.stringify({ chronoOk: true }),
    });
    expect(checkIn.status).toBe(200);
  });

  it('lets check-in find a waiver signed before the booking existed', async () => {
    const email = `ahead${crypto.randomUUID().slice(0, 8)}@example.com`;

    // Signed first, with nothing to attach to.
    const res = await sign({ signerName: 'Early Bird', email });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).linkedAttendees).toBe(0);

    // Books afterwards, so the seat is created with no waiver on it.
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1, { email });
    const attendee = await env.DB.prepare(
      `SELECT id, waiver_id FROM booking_attendees WHERE attendee_token = ?1`,
    )
      .bind(body.attendees[0].token)
      .first<{ id: number; waiver_id: number | null }>();
    expect(attendee?.waiver_id).toBeNull();

    const checkIn = await SELF.fetch(`https://x/api/admin/attendees/${attendee!.id}/check-in`, {
      method: 'POST',
      headers: { ...ADMIN, ...JSON_HEADERS },
      body: JSON.stringify({ chronoOk: true }),
    });
    expect(checkIn.status).toBe(200);
  });

  it('will not let a blacklisted player put a waiver on file', async () => {
    const email = `banned${crypto.randomUUID().slice(0, 8)}@example.com`;
    await env.DB.prepare(
      `INSERT INTO players (email, full_name, blacklisted) VALUES (?1, 'Banned Player', 1)`,
    )
      .bind(email)
      .run();

    const res = await sign({ signerName: 'Banned Player', email });

    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('player_blocked');
  });
});

describe('check-in', () => {
  it('refuses anyone without a waiver on file', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const attendee = await env.DB.prepare(
      `SELECT id FROM booking_attendees WHERE attendee_token = ?1`,
    )
      .bind(body.attendees[0].token)
      .first<{ id: number }>();

    const res = await SELF.fetch(`https://x/api/admin/attendees/${attendee!.id}/check-in`, {
      method: 'POST',
      headers: { ...ADMIN, ...JSON_HEADERS },
      body: JSON.stringify({ chronoOk: true }),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.code).toBe('waiver_missing');
  });

  it('refuses a waiver that has expired', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const sha = await currentSha();

    await SELF.fetch(`https://x/api/waiver/attendee/${body.attendees[0].token}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: signBody({}, sha),
    });

    // Age the signature past its validity window.
    await env.DB.prepare(
      `UPDATE waivers SET expires_at = '2020-01-01T00:00:00.000Z'
        WHERE id = (SELECT waiver_id FROM booking_attendees WHERE attendee_token = ?1)`,
    )
      .bind(body.attendees[0].token)
      .run();

    const attendee = await env.DB.prepare(
      `SELECT id FROM booking_attendees WHERE attendee_token = ?1`,
    )
      .bind(body.attendees[0].token)
      .first<{ id: number }>();

    const res = await SELF.fetch(`https://x/api/admin/attendees/${attendee!.id}/check-in`, {
      method: 'POST',
      headers: { ...ADMIN, ...JSON_HEADERS },
      body: JSON.stringify({ chronoOk: true }),
    });

    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error.code).toBe('waiver_expired');
  });

  it('requires a staff token', async () => {
    const res = await SELF.fetch('https://x/api/admin/events');
    expect(res.status).toBe(401);
  });
});

describe('payments', () => {
  const completedEvent = (id: string, ref: string) =>
    JSON.stringify({
      id,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${ref}`,
          client_reference_id: ref,
          payment_status: 'paid',
          payment_intent: `pi_${ref}`,
        },
      },
    });

  const postWebhook = (payload: string) =>
    SELF.fetch('https://x/api/stripe/webhook', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: payload,
    });

  it('applies a redelivered event exactly once', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);
    const payload = completedEvent('evt_replay_1', body.ref);

    const first = await postWebhook(payload);
    const second = await postWebhook(payload);

    expect(((await first.json()) as any).duplicate).toBe(false);
    expect(((await second.json()) as any).duplicate).toBe(true);

    const payments = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM payments p
         JOIN bookings b ON b.id = p.booking_id
        WHERE b.ref = ?1`,
    )
      .bind(body.ref)
      .first<{ n: number }>();

    expect(payments?.n).toBe(1);
  });

  it('releases the spots when a checkout session expires', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 2);
    expect(await spotsTaken(event.id)).toBe(2);

    await postWebhook(
      JSON.stringify({
        id: 'evt_expired_1',
        type: 'checkout.session.expired',
        data: { object: { id: `cs_${body.ref}`, client_reference_id: body.ref } },
      }),
    );

    expect(await spotsTaken(event.id)).toBe(0);
  });

  it('does not grant entry while a delayed payment is still unpaid', async () => {
    const event = await makeEvent(5);
    const { body } = await book(event.slug, 1);

    await postWebhook(
      JSON.stringify({
        id: 'evt_unpaid_1',
        type: 'checkout.session.completed',
        data: {
          object: { id: `cs_${body.ref}`, client_reference_id: body.ref, payment_status: 'unpaid' },
        },
      }),
    );

    const row = await env.DB.prepare(`SELECT status FROM bookings WHERE ref = ?1`)
      .bind(body.ref)
      .first<{ status: string }>();
    expect(row?.status).toBe('pending_payment');
  });
});

describe('hold sweeper', () => {
  // No cleanup between tests: every test books against its own event, and the
  // sweeper only touches holds whose expiry has been pushed into the past, so
  // bookings from other tests are invisible to it.
  it('releases expired holds and leaves paid bookings alone', async () => {
    const event = await makeEvent(10);
    const stale = await book(event.slug, 2);
    const paid = await book(event.slug, 3);
    const fresh = await book(event.slug, 1);
    expect(await spotsTaken(event.id)).toBe(6);

    // One booking paid, one hold pushed into the past, one still live.
    await SELF.fetch(`https://x/api/admin/bookings/${paid.body.ref}/mark-paid`, {
      method: 'POST',
      headers: ADMIN,
    });
    await env.DB.prepare(
      `UPDATE bookings SET hold_expires_at = '2020-01-01T00:00:00.000Z' WHERE ref = ?1`,
    )
      .bind(stale.body.ref)
      .run();

    const res = await SELF.fetch('https://x/api/admin/sweep-holds', {
      method: 'POST',
      headers: ADMIN,
    });

    expect(((await res.json()) as any).released).toBe(1);
    // Only the stale hold's 2 spots come back.
    expect(await spotsTaken(event.id)).toBe(4);

    const statuses = await env.DB.prepare(
      `SELECT ref, status FROM bookings WHERE ref IN (?1, ?2, ?3)`,
    )
      .bind(stale.body.ref, paid.body.ref, fresh.body.ref)
      .all<{ ref: string; status: string }>();

    const byRef = Object.fromEntries(statuses.results.map((r) => [r.ref, r.status]));
    expect(byRef[stale.body.ref]).toBe('expired');
    expect(byRef[paid.body.ref]).toBe('paid');
    expect(byRef[fresh.body.ref]).toBe('pending_payment');
  });
});

describe('admin guards', () => {
  it('will not shrink capacity below the spots already sold', async () => {
    const event = await makeEvent(10);
    await book(event.slug, 4);

    const res = await SELF.fetch(`https://x/api/admin/events/${event.id}`, {
      method: 'PATCH',
      headers: { ...ADMIN, ...JSON_HEADERS },
      body: JSON.stringify({ capacity: 2 }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('capacity_below_booked');
  });

  it('publishing new waiver wording keeps the old version and its hash', async () => {
    const before = await currentSha();

    const res = await SELF.fetch('https://x/api/admin/waiver-versions', {
      method: 'POST',
      headers: { ...ADMIN, ...JSON_HEADERS },
      body: JSON.stringify({ version: 'test-v2', body: 'Shorter waiver text for the test.' }),
    });
    expect(res.status).toBe(201);

    const after = await currentSha();
    expect(after).not.toBe(before);

    const kept = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM waiver_versions WHERE body_sha256 = ?1`,
    )
      .bind(before)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
  });
});

describe('contact form', () => {
  const realFetch = globalThis.fetch;

  /**
   * Intercepts calls to Resend only, so SELF.fetch and everything else keep
   * working. `handler` stands in for what Resend would have answered.
   */
  function stubResend(handler: (payload: any) => Response) {
    env.RESEND_API_KEY = 'test-resend-key';
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.resend.com')) return realFetch(input as RequestInfo, init);
      return Promise.resolve(handler(JSON.parse(String(init?.body ?? '{}'))));
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete env.RESEND_API_KEY;
  });

  let ipSeq = 0;
  // A fresh address per test: the flood check counts by IP, and tests that are
  // not about rate limiting must not spend each other's allowance.
  const freshIp = () => `203.0.113.${++ipSeq % 250}`;

  const send = (body: Record<string, unknown>, ip = freshIp()) =>
    SELF.fetch('https://x/api/contact', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'CF-Connecting-IP': ip },
      body: JSON.stringify(body),
    });

  const message = (extra: Record<string, unknown> = {}) => ({
    name: 'Casey Player',
    email: `c${crypto.randomUUID().slice(0, 8)}@example.com`,
    message: 'Do you take group bookings for eight people?',
    ...extra,
  });

  const stored = (email: string) =>
    env.DB.prepare(
      `SELECT name, email, message, emailed, error FROM contact_messages WHERE email = ?1`,
    )
      .bind(email)
      .first<{ name: string; email: string; message: string; emailed: number; error: string | null }>();

  it('stores the message and emails it', async () => {
    let sent: any;
    stubResend((payload) => {
      sent = payload;
      return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    });

    const body = message();
    const res = await send(body);
    expect(res.status).toBe(200);

    const row = await stored(body.email);
    expect(row?.message).toBe(body.message);
    expect(row?.emailed).toBe(1);
    expect(row?.error).toBeNull();

    // The address the form is for, and the reply path back to the sender.
    expect(sent.to).toEqual(['coyoteridgeairsoft@gmail.com']);
    expect(sent.reply_to).toBe(body.email);
    expect(sent.text).toContain(body.message);
  });

  it('keeps the message when the email fails to send', async () => {
    stubResend(() => new Response('domain not verified', { status: 403 }));

    const body = message();
    const res = await send(body);

    // The sender is told it worked, because from their side it did: the
    // message is on disk and staff can read it at /api/admin/messages.
    expect(res.status).toBe(200);

    const row = await stored(body.email);
    expect(row?.emailed).toBe(0);
    expect(row?.error).toContain('resend_403');
  });

  it('stores the message when no mail transport is configured', async () => {
    const body = message();
    expect((await send(body)).status).toBe(200);

    const row = await stored(body.email);
    expect(row?.emailed).toBe(0);
    expect(row?.error).toBe('not_configured');
  });

  it('rejects an empty message and a malformed address', async () => {
    const blank = await send(message({ message: '   ' }));
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as any).error.code).toBe('missing_field');

    const bad = await send(message({ email: 'not-an-address' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('invalid_email');
  });

  it('silently drops a submission that filled in the honeypot', async () => {
    const body = message({ company: 'Acme Widgets' });
    const res = await send(body);

    // Success shape, so a bot learns nothing about why it failed...
    expect(res.status).toBe(200);
    // ...and nothing is stored.
    expect(await stored(body.email)).toBeNull();
  });

  it('rate limits one address after five messages', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 5; i++) {
      expect((await send(message(), ip)).status).toBe(200);
    }

    const sixth = await send(message(), ip);
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as any).error.code).toBe('too_many_messages');
  });

  it('serves stored messages to staff and nobody else', async () => {
    const body = message();
    await send(body);

    const denied = await SELF.fetch('https://x/api/admin/messages');
    expect(denied.status).toBe(401);

    const res = await SELF.fetch('https://x/api/admin/messages', { headers: ADMIN });
    expect(res.status).toBe(200);

    const { messages } = (await res.json()) as any;
    const mine = messages.find((m: any) => m.email === body.email);
    expect(mine.message).toBe(body.message);
    expect(mine.emailed).toBe(false);
  });
});
