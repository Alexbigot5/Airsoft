# Coyote Ridge Airsoft

Marketing site plus a Cloudflare Workers + D1 backend for player registration,
waivers and payments.

The site itself (`public/index.html`) is a bundled export and is treated
as **read-only** — the Worker serves it and injects two scripts and a stylesheet
that carry every change made to it since: the real game-day schedule, the map,
the Instagram and Discord links, the waiver call-to-action, the home-page
gallery, the logo in the nav, a mobile menu, the field's real contact details,
and the removal of its mock Book page.
Everything under `src/`, `public/` and `migrations/` is the part you maintain.

## What it does

- **Registration** — pick a game day and package, book for a party of up to 20.
  Spots are held immediately so two people cannot buy the same last spot.
- **Waivers** — one per attendee, not one per booking. Typed e-signature, stored
  with the exact waiver text hash, date of birth, guardian details for minors,
  emergency contact, timestamp, IP and user agent. Valid for one year. Reachable
  two ways: the seat-specific link that comes with a booking, and a standalone
  `/waiver` page for signing ahead of time. **The marketing page no longer links
  to `/waiver`** — its waiver buttons point at the field's Google Form (see
  `WAIVER_URL` in `public/site-enhance.js`). Both pages still work; only the
  links moved.
- **Payments** — Stripe Checkout. The Worker creates the session; a signed,
  idempotent webhook is what actually marks a booking paid.
- **Staff console** — `/admin`, gated by a shared token. Day-of roster, mark
  paid (cash at the gate), check in. **Check-in is refused for anyone without a
  current signed waiver.**
- **Contact form** — the marketing page's "Send a message" panel. Messages are
  stored in D1 and emailed to the field, in that order, so a mail outage costs a
  notification rather than the message.

## Layout

```
wrangler.jsonc              bindings, cron trigger, vars
migrations/                 D1 schema and seed data
seeds/dev_events.sql        sample game days for local use (not a migration)
src/
  index.ts                  router, error shape, HTMLRewriter injection, cron
  db.ts  validate.ts        helpers: ids, hashing, age, field validation
  stripe.ts                 Checkout + webhook verification (fetch, no SDK)
  mail.ts                   contact-form email via Resend (fetch, no SDK)
  sweeper.ts                releases spots held by abandoned checkouts
  routes/                   events, bookings, waivers, checkout, contact, admin
public/
  index.html                the marketing page (read-only, never edited)
  site-hook.js              injected into it to redirect the mock "Book" buttons
  site-enhance.js/.css      injected too: schedule, map, gallery, waiver, nav
  img/                      the home-page gallery photographs, and logo.png
  register / waiver / success / admin pages, app.css
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

1. `/` — the marketing page. Generic "Book"/"Reserve" buttons go to the Games
   page; each game day there books through its own registration form.
2. `/register` — book 2 spots. You land on the simulated checkout; pay.
3. `/success?ref=…` — flips to paid, and lists a waiver link per attendee.
4. Open each waiver link and sign. Use a date of birth under 18 to see the
   guardian block appear and be enforced.
5. `/admin` — sign in with the token from `.dev.vars` (`dev-admin-token`), pick
   the game day, check both players in. Try checking in an unsigned attendee:
   it is refused, by design.
6. `/waiver` with no token — the standalone waiver. Sign it with an email that
   has no booking, then book with that same email and check in: the signature is
   found by email and entry is allowed.
7. `/` → Contact → fill in "Send a message" and send. With `RESEND_API_KEY`
   empty the message is stored and not emailed, which is the point: it is still
   there at `GET /api/admin/messages`, marked `emailed: false`.

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
waiver, webhook replay, the hold sweeper, and the contact form — including that
a message survives a failed send, which is the whole reason it is stored first.

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

`PUBLIC_BASE_URL` can stay empty: Stripe redirect and waiver links are built
from the origin of the incoming request, which is correct on workers.dev and in
local dev alike. Set it only if you put a custom domain in front and want every
link to use that canonical origin instead.

If you deploy through **Workers Builds** (connected repo) rather than from your
machine, note that it runs `wrangler deploy` directly — npm lifecycle hooks do
not fire, so anything the deploy depends on has to be committed, not generated
at deploy time. The Worker `name` in `wrangler.jsonc` also has to match the
Workers Builds project name, or CI overrides it on every build.

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

### Contact form email

Messages from the "Send a message" form on the Contact page are **always stored**
in `contact_messages` and readable at `GET /api/admin/messages`. Emailing them
on to the field's inbox is the part that needs setting up, and a deployment
without it loses notifications, not messages.

Workers cannot open an SMTP connection, so mail goes out over an HTTP API —
[Resend](https://resend.com) here, called from `src/mail.ts` the same way
`src/stripe.ts` calls Stripe.

```bash
npx wrangler secret put RESEND_API_KEY
```

Two vars in `wrangler.jsonc` control the rest:

- `CONTACT_EMAIL` — where messages are delivered. Defaults to
  `coyoteridgeairsoft@gmail.com` if unset.
- `CONTACT_FROM` — who they come from. **Resend refuses any sender outside a
  domain verified on the account**, so this has to change at the same time as
  verifying one. Verifying a domain means adding the DKIM and SPF records Resend
  gives you to that domain's DNS. The committed value is
  `onboarding@resend.dev`, which needs no DNS but only delivers to the address
  that owns the Resend account — right for testing, wrong for production.

The visitor's address goes in `reply_to`, so hitting Reply in the inbox answers
them rather than the Worker. Message bodies are sent as plain text and never as
HTML: a contact form is an open door, and rendering a stranger's message as
markup in the field's mailbox would hand them working links in front of staff.

If a send fails, the row keeps `emailed = 0` and the reason in `error`, the
Worker logs it, and the visitor is still told the message was received — because
it was. Check `GET /api/admin/messages` for anything with `emailed: false`.

Two things keep the endpoint from being a spam relay: a honeypot field that is
hidden from people and dropped silently when filled, and a per-IP limit of five
messages in ten minutes.

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
| POST | `/api/waiver/sign` | sign the standalone waiver, no booking needed |
| POST | `/api/contact` | contact form; stores the message, then emails it |
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
| GET | `/api/admin/messages` | contact form messages, newest first |
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
- **The standalone waiver is matched by email.** `/waiver` with no token has no
  seat to attach to, so it files the signature against the player — the same
  email-as-identity bookings already use — and links it to any seat booked under
  that address. A seat booked *after* the signature is resolved the same way at
  check-in. Two consequences worth knowing: age is judged as of the day it is
  signed rather than a game day, so someone who turns 12 next month signs next
  month; and re-submitting the identical name and date of birth returns the
  existing signature instead of stacking up rows, while a *different* name or
  date of birth is treated as a correction and does get its own row.
- **The game days live in `public/site-enhance.js`.** `EVENTS` at the top of that
  file is the one place to edit them: date, title, time, and the registration
  form each one books through. They replace the sample games the
  export shipped, on both the home page and the Games page. There are no spot
  counts — the export showed "6 / 40 spots left" from sample data with nothing
  behind it, which reads as live availability and is worse than showing nothing.
  This list is separate from the `events` table in D1, which is what `/register`
  and the staff console run on; if sign-up ever moves back in-house, the Games
  page should read `/api/events` instead of this array.
- **The waiver is a Google Form.** Every waiver link on the marketing page — the
  call-to-action on the Games page and the item in the phone menu — points at
  it. `WAIVER_URL` in `public/site-enhance.js` is the one place to change it.
  The in-house `/waiver` page and `POST /api/waiver/sign` are untouched and
  still work; if signing ever moves back in-house, point that constant at
  `/waiver` again and nothing else needs to change.
- **The home page's game modes are a gallery now.** The export's "Five ways to
  run the field" was five invented modes with invented player counts, of a piece
  with the sample schedule and the mock booking form. `GALLERY` in
  `public/site-enhance.js` lists the photographs that replaced them; the files
  live in `public/img/`. Exactly one entry is `wide: true`, which is what makes
  seven photos fill the four-column grid to the edge — adding or removing one
  means re-checking that.
- **The About page shows the field's own photographs.** The export shipped seven
  stock ones there: the card beside the opening copy, and six in the "On the
  field" grid. `ABOUT_CARD` and `ABOUT_GALLERY` in `public/site-enhance.js` are
  where they are set, with the files in `public/img/`. The grid is three columns
  and the bundle draws six cells for it; entries past the sixth get a cell of
  their own. The spans have to add up to whole rows: the bundle's first cell is
  four cells' worth and a `tall: true` entry is two, so the eight photos come to
  twelve — four full rows, no ragged tail. Adding or removing one means
  re-checking that.
- **The nav and the footer show the field's badge.** It replaces the export's
  "CR" tiles, and it is the one file this repo expects to be there and does not
  ship a fallback for in code: `LOGO_SRC` in `public/site-enhance.js` points at
  `public/img/logo.png`. The swap waits for that file to load and leaves the
  "CR" tiles alone if it does not, so a missing or renamed logo costs the page
  its badge and nothing else. Both marks are the same tile in the bundle and are
  sized apart in `site-enhance.css`: the nav's is capped by the 74px row, the
  footer's is not.
- **The Woodland field is 3.5 acres.** The export's card said 40. `FIELD_SIZE`
  in `public/site-enhance.js` is where it is set, matched against the chip's
  original text — reword that chip in the export and the export's number comes
  back.
- **The export invented the field's contact details.** It wrote the real phone
  number and email into the link *text* on the Contact page but left its own
  stand-ins in the `href`s, so the page read correctly and dialled a 612 number
  and mailed ironsight.gg. The footer had a Timberline Rd address in a Sector 7
  that does not exist, the hero had coordinates in Minnesota, and the copyright
  line named a different operator and then said it was placeholder content. All
  of it is corrected from the constants at the top of `public/site-enhance.js`.
- **"Open Sat + Sun" was never true.** The hero's field status reads "open for
  scheduled events only" and the Contact page's game-day hours match it, because
  the field opens for the days in `EVENTS` and nothing else. The hero's second
  chip — "NEXT GAME: SAT 08:30" — is hidden rather than rewritten: it would need
  updating after every game day to stay true, and the schedule below it is
  already the answer.
- **The footer's "Play" column is gone**, along with the four-column track it
  sat in. Its three entries were plain spans, not links, naming services the
  field does not sell separately. `.fgrid` is four fixed tracks, so
  `site-enhance.css` re-cuts them to three above 900px; below that the bundle
  collapses the footer to one column anyway.
- **The page has no em dashes in it.** `BUNDLE_REWRITES` in
  `public/site-enhance.js` pairs each sentence the export wrote with that
  sentence rewritten, because a dash stands where a comma, a colon or a full
  stop belongs and which one belongs is a per-sentence question.
  `rewriteEmDashes()` applies the table to the rendered page, then falls back to
  a mechanical fix for anything the table does not name, which is what makes the
  guarantee hold for copy nobody has looked at yet. Reword one of those
  sentences in the bundle and the table entry stops matching, the same
  brittleness `HIDDEN_FAQ_QUESTIONS` has; the fallback is the safety net. Still
  outstanding: the `<title>` of the waiver, register, success and admin pages.
- **The FAQ is one entry.** "Do I need my own gear?" is all that is left on the
  About page, and its answer is rewritten to say that gear rentals are not
  available — the thing players turn up expecting, which the export's answer did
  not mention. The age, group-booking, what-to-bring and rain questions are
  hidden. `HIDDEN_FAQ_QUESTIONS` and `FAQ_ANSWERS` in `public/site-enhance.js`
  both match on the question text, so rewording a question in the bundle brings
  its entry back, or brings back the export's own answer.
- **The Games page safety brief is gone** — six cards paraphrasing rules the
  Rules page already carries in full and dated, which meant two places saying
  the same thing and one of them maintained. `hideSafetyBrief()` in
  `public/site-enhance.js` finds it by its heading and hides the divider above
  it too. The Rules page is untouched.
- **The Book page is gone**, along with its mock booking form. Buttons that name
  no particular game day ("Reserve a spot", the nav's "Reserve →") now go to the
  Games page, since sign-up is per event and there is nowhere else for a generic
  button to lead. `/register` and the Stripe flow behind it are untouched and
  still live at that URL.
- **The map needs no API key.** The Contact page embeds
  `google.com/maps?q=…&output=embed`, which works without a billing-enabled
  Google Cloud project. If the field's pin ever needs to be exact rather than
  geocoded from the street address, swap `MAP_EMBED_URL` in
  `public/site-enhance.js` for a coordinate query or a Maps Embed API URL.
- **The bundle had no mobile navigation at all.** Its own stylesheet hides the
  nav links below 900px without shipping a replacement, so Games, About and
  Contact were unreachable on a phone. `site-enhance.js` adds the menu, and
  `site-enhance.css` collapses the two-column layouts the export left fixed —
  matched by inline-style attribute, in both the unspaced form the bundle authors
  and the spaced form React re-serializes them to.
- **The contact form used to send nothing anywhere.** The bundle's "Send a
  message" button was bound to `sendMsg:()=>this.setState({msgSent:true})` — it
  flipped the label to "Message sent ✓" and stopped there, and the three inputs
  were bound to no state at all, so what a visitor typed was read by nobody. It
  now posts to `POST /api/contact`, which stores the message and emails it. The
  panel is left in the bundle and its click intercepted in the capture phase,
  the way `site-hook.js` intercepts the mock booking buttons; the values are
  read straight off the DOM nodes, which works precisely because the bundle
  ignores them. See "Contact form email" below.
- **Booking email is still not sent.** Waiver links are shown to the booker on
  `/success`. `src/mail.ts` is now there to build on, so wiring up a booking
  confirmation is a smaller change than it was.
- **Refunds** are initiated in the Stripe dashboard; the `charge.refunded`
  webhook records them and releases the spot if the game has not happened yet.
