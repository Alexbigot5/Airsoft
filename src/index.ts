import { Hono } from 'hono';
import type { AppBindings, Env } from './types';
import { ApiError } from './validate';
import { events } from './routes/events';
import { bookings } from './routes/bookings';
import { waivers } from './routes/waivers';
import { checkout } from './routes/checkout';
import { admin } from './routes/admin';
import { sweepExpiredHolds } from './sweeper';

const app = new Hono<AppBindings>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error('unhandled error', err);
  return c.json(
    { error: { code: 'internal_error', message: 'Something went wrong on our end.' } },
    500,
  );
});

app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404)
    : c.text('Not found', 404),
);

app.route('/api', events);
app.route('/api', bookings);
app.route('/api', waivers);
app.route('/api', checkout);
app.route('/api/admin', admin);

// The bundled page is also reachable by its own filename; send it to "/" so
// nobody gets the copy without the site hook and its mock booking flow.
app.get('/index.html', (c) => c.redirect('/', 301));

/**
 * The marketing page is a 3 MB bundled export that we treat as read-only: it
 * lives at public/index.html and is served here with a single <script>
 * appended, which is what redirects its mock "Book" buttons at the real
 * registration flow. Streaming through HTMLRewriter avoids ever holding the
 * whole document in memory.
 */
app.get('/', async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  if (!asset.ok) return asset;

  return new HTMLRewriter()
    .on('body', {
      element(el) {
        el.append('<script src="/site-hook.js" defer></script>', { html: true });
      },
    })
    .transform(
      new Response(asset.body, {
        status: asset.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
});

export default {
  fetch: app.fetch,

  // Releases spots held by Checkout sessions that were started but never paid.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      sweepExpiredHolds(env).then((n) => {
        if (n > 0) console.log(`sweeper: released holds on ${n} booking(s)`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
