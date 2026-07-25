# Coyote Ridge Airsoft

Marketing site plus a Cloudflare Workers + D1 backend for player registration,
waivers and payments.

The site itself (`Coyote Ridge Airsoft.html`) is a bundled export and is treated
as **read-only** — the Worker serves it and injects one script that points its
"Book" buttons at the real flow. Everything under `src/`, `public/` and
`migrations/` is the part you maintain.

## What it does

- **Registration** — pick a game day and package, book for a party of up to 20.
  Spots are held immediately so two people cannot buy the same last spot.
- **Waivers** — one per attendee, not one per booking. Typed e-signature, stored
  with the exact waiver text hash, date of birth, guardian details for minors,
  emergency contact, timestamp, IP and user agent. Valid for one year.
- **Payments** — Stripe Checkout. The Worker creates the session; a signed,
  idempotent webhook is what actually marks a booking paid.
- **Staff console** — `/admin`, gated by a shared token. Day-of roster, mark
  paid (cash at the gate), check in. **Check-in is refused for anyone without a
  current signed waiver.**

## Layout

```
Coyote Ridge Airsoft.html   the marketing page (read-only, never edited)
scripts/sync-site.mjs       copies it into public/index.html for Workers Assets
wrangler.jsonc              bindings, cron trigger, vars
migrations/                 D1 schema and seed data
seeds/dev_events.sql        sample game days for local use (not a migration)
src/
  index.ts                  router, error shape, HTMLRewriter injection, cron
  db.ts  validate.ts        helpers: ids, hashing, age, field validation
  stripe.ts                 Checkout + webhook verification (fetch, no SDK)
  sweeper.ts                releases spots held by abandoned checkouts
  routes/                   events, bookings, waivers, checkout, admin
public/                     register / waiver / success / admin pages, site-hook
test/api.spec.ts            the rules that cost money or create liability
```

## Local development

No Cloudflare account or Stripe key is needed to run the whole flow locally.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local                                   # apply migrations
npx wrangler d1 execute airsoft-db --local --file=seeds/dev_events.sql
npm run dev                                        # http://localhost:8787
```

With `STRIPE_SECRET_KEY` empty, checkout is simulated: `/api/dev/checkout`
stands in for Stripe's hosted page and pushes a synthetic
`checkout.session.completed` through the *real* webhook handler, so the stub
exercises the production path rather than a shortcut around it.

### Walk it end to end

1. `/` — the marketing page. "Book" now goes to `/register`.
2. `/register` — book 2 spots. You land on the simulated checkout; pay.
3. `/success?ref=…` — flips to paid, and lists a waiver link per attendee.
4. Open each waiver link and sign. Use a date of birth under 18 to see the
   guardian block appear and be enforced.
5. `/admin` — sign in with the token from `.dev.vars` (`dev-admin-token`), pick
   the game day, check both players in. Try checking in an unsigned attendee:
   it is refused, by design.

Inspect state directly at any point:

```bash
npx wrangler d1 execute airsoft-db --local \
  --command "SELECT ref,status,party_size FROM bookings;
             SELECT slug,capacity,spots_taken FROM events;"
```

### Tests

```bash
npm test        # vitest against real workerd + local D1
npm run typecheck
```

The suite covers overselling under concurrent bookings, server-side pricing,
minors and the age floor, stale waiver text, check-in without or with an expired
waiver, webhook replay, and the hold sweeper.

Cron triggers do not fire automatically in local dev. Run the sweeper by hand
with the button on `/admin`, or:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Going live

These steps need a Cloudflare account and a Stripe account.

```bash
npx wrangler login
npx wrangler d1 create airsoft-db     # paste the id into wrangler.jsonc
npx wrangler d1 migrations apply airsoft-db --remote

npx wrangler secret put ADMIN_TOKEN            # staff token for /admin
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET

npx wrangler deploy
```

Set `PUBLIC_BASE_URL` in `wrangler.jsonc` to the real origin — it is what
Stripe redirect and waiver links are built from.

Then add a webhook endpoint in the Stripe dashboard pointing at
`https://<your-worker>/api/stripe/webhook`, subscribed to:

- `checkout.session.completed`
- `checkout.session.expired`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.refunded`

Paste its signing secret into `STRIPE_WEBHOOK_SECRET`. To rehearse against real
Stripe test mode locally:

```bash
stripe listen --forward-to localhost:8787/api/stripe/webhook
```

A missing `STRIPE_WEBHOOK_SECRET` on a deployment that *has* a Stripe key is
treated as a misconfiguration and rejected — unsigned events are only accepted
in the fully unconfigured local mode.

## API

Public:

| Method | Path | Notes |
|---|---|---|
| GET | `/api/events` | upcoming game days, `?field=woodland\|cqb` |
| GET | `/api/events/:slug` | one game day plus packages |
| GET | `/api/packages` | active packages |
| POST | `/api/bookings` | creates the booking and holds spots |
| GET | `/api/bookings/:ref` | booking, payment and per-attendee waiver status |
| POST | `/api/bookings/:ref/checkout` | returns a Checkout URL |
| GET | `/api/waiver/current` | active waiver text and its hash |
| GET/POST | `/api/waiver/attendee/:token` | read and sign one attendee's waiver |
| POST | `/api/stripe/webhook` | signature-verified, idempotent |

Staff — all require `Authorization: Bearer $ADMIN_TOKEN`:

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/admin/events` | list, create |
| PATCH | `/api/admin/events/:id` | capacity cannot go below spots sold |
| GET | `/api/admin/events/:id/roster` | the day-of screen |
| GET | `/api/admin/bookings` | `?status=&eventId=` |
| POST | `/api/admin/bookings/:ref/mark-paid` | cash at the gate |
| POST | `/api/admin/bookings/:ref/cancel` | releases the spots |
| POST | `/api/admin/attendees/:id/check-in` | refused without a valid waiver |
| POST | `/api/admin/attendees/:id/undo-check-in` | |
| GET/POST | `/api/admin/waiver-versions` | publish new wording |
| POST | `/api/admin/sweep-holds` | run the sweeper now |

Errors are `{ "error": { "code", "message" } }` with a real status code.

## How capacity is protected

Spots are reserved with a single conditional statement, never a read followed by
a write:

```sql
UPDATE events SET spots_taken = spots_taken + ?1
 WHERE id = ?2 AND status = 'scheduled' AND spots_taken + ?1 <= capacity;
```

If no row changed, the event is full or closed and the booking is rejected. A
`CHECK (spots_taken <= capacity)` constraint backs it up at the schema level.

The trade-off is that spots are held from the moment a booking is created,
before payment — so unpaid bookings carry `hold_expires_at` (30 minutes) and a
cron sweeper reclaims them. The sweeper only touches `pending_payment` rows, so
a payment that lands late cannot have its spot reclaimed underneath it.

One case remains: a payment that succeeds *after* its hold was swept, on an
event that has since filled. Rather than quietly take money for a spot that no
longer exists, the booking is marked paid and flagged `overbooked`, which shows
up on the roster for staff to resolve.

## Things worth knowing

- **No accounts and no passwords.** A booking is reachable by its unguessable
  reference, a waiver by its attendee token. Appropriate for a walk-on field,
  but anyone holding a link holds that booking — worth remembering before those
  links get pasted into a Discord.
- **The seeded waiver text is not legal advice.** It is drawn from the site's
  own posted rules. Replace it with wording your insurer or an attorney approves
  before real players sign, via `POST /api/admin/waiver-versions` — old versions
  and their hashes are kept so existing signatures still resolve to the text that
  was actually signed.
- **Waivers are append-only.** There is no update or delete path. A correction
  is a new signature.
- **No email is sent yet.** Waiver links are shown to the booker on `/success`.
  Adding Resend or MailChannels later is a small, isolated change.
- **Refunds** are initiated in the Stripe dashboard; the `charge.refunded`
  webhook records them and releases the spot if the game has not happened yet.
