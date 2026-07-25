import { Hono } from 'hono';
import type { AppBindings, EventRow, PackageRow } from '../types';
import { ApiError } from '../validate';
import { nowIso } from '../db';

export const events = new Hono<AppBindings>();

const publicEvent = (row: EventRow) => ({
  slug: row.slug,
  title: row.title,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  mode: row.mode,
  field: row.field,
  level: row.level,
  capacity: row.capacity,
  spotsLeft: Math.max(0, row.capacity - row.spots_taken),
  basePriceCents: row.base_price_cents,
  note: row.note,
  status: row.status,
});

const publicPackage = (row: PackageRow) => ({
  id: row.id,
  name: row.name,
  blurb: row.blurb,
  priceCents: row.price_cents,
  includes: JSON.parse(row.includes_json) as string[],
});

const EVENT_COLUMNS = `id, slug, title, starts_at, ends_at, mode, field, level,
                       capacity, spots_taken, base_price_cents, note, status`;

events.get('/events', async (c) => {
  const field = c.req.query('field');
  if (field && field !== 'woodland' && field !== 'cqb') {
    throw new ApiError(400, 'invalid_filter', 'field must be "woodland" or "cqb".');
  }

  const sql = `SELECT ${EVENT_COLUMNS}
                 FROM events
                WHERE status = 'scheduled'
                  AND starts_at >= ?1
                  ${field ? 'AND field = ?2' : ''}
                ORDER BY starts_at ASC
                LIMIT 50`;
  const stmt = field
    ? c.env.DB.prepare(sql).bind(nowIso(), field)
    : c.env.DB.prepare(sql).bind(nowIso());

  const { results } = await stmt.all<EventRow>();
  return c.json({ events: results.map(publicEvent) });
});

events.get('/events/:slug', async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE slug = ?1`)
    .bind(c.req.param('slug'))
    .first<EventRow>();
  if (!row) throw new ApiError(404, 'event_not_found', 'No such game day.');

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, blurb, price_cents, includes_json, active, sort_order
       FROM packages WHERE active = 1 ORDER BY sort_order`,
  ).all<PackageRow>();

  return c.json({ event: publicEvent(row), packages: results.map(publicPackage) });
});

events.get('/packages', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, blurb, price_cents, includes_json, active, sort_order
       FROM packages WHERE active = 1 ORDER BY sort_order`,
  ).all<PackageRow>();
  return c.json({ packages: results.map(publicPackage) });
});
