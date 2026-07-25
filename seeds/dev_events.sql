-- Sample game days for local development and staging.
--
-- Deliberately NOT a migration: migrations run against production too, and you
-- do not want fake events on the real schedule. Apply it by hand:
--
--   wrangler d1 execute airsoft-db --local --file=seeds/dev_events.sql
--
-- Dates are relative to "now" so the seed never goes stale. Re-running it is
-- safe: the slugs are fixed and the inserts are OR IGNORE.

INSERT OR IGNORE INTO events
  (slug, title, starts_at, ends_at, mode, field, level, capacity, base_price_cents, note)
VALUES
  ('sat-woodland-skirmish',
   'Woodland Skirmish',
   strftime('%Y-%m-%dT16:30:00.000Z', 'now', '+5 days'),
   strftime('%Y-%m-%dT23:00:00.000Z', 'now', '+5 days'),
   'Objective rotation', 'woodland', 'All levels', 40, 3500,
   'Objective rotation every 30 min. All levels welcome.'),

  ('sat-cqb-night',
   'CQB Compound',
   strftime('%Y-%m-%dT20:00:00.000Z', 'now', '+5 days'),
   strftime('%Y-%m-%dT23:59:00.000Z', 'now', '+5 days'),
   'Fast respawn', 'cqb', 'All levels', 32, 3500,
   'Fast respawn, tight corners. Full-seal eye pro required.'),

  ('sun-capture-the-flag',
   'Capture the Flag',
   strftime('%Y-%m-%dT17:00:00.000Z', 'now', '+6 days'),
   strftime('%Y-%m-%dT23:00:00.000Z', 'now', '+6 days'),
   'CTF', 'woodland', 'Intermediate', 40, 3500,
   'Two flags, no respawn on the final push.');
