import type { Env } from './types';
import { nowIso } from './db';

/**
 * Releases spots held by bookings that never got paid.
 *
 * Spots are held from the moment a booking is created, before payment -- that
 * is what stops two people buying the same last spot while one of them is on
 * the Stripe page. The cost is that an abandoned checkout would hold a spot
 * forever, so every unpaid booking carries hold_expires_at and this runs on a
 * cron to reclaim them.
 *
 * Only 'pending_payment' rows are touched, so a payment that lands late cannot
 * have its spot reclaimed out from under it.
 */
export async function sweepExpiredHolds(env: Env, at = nowIso()): Promise<number> {
  const [, expired] = await env.DB.batch([
    // Give the spots back first -- while the bookings are still identifiable as
    // expired holds. Reversing these two would leave the count untouched.
    env.DB.prepare(
      `UPDATE events
          SET spots_taken = MAX(0, spots_taken - COALESCE((
                SELECT SUM(b.party_size)
                  FROM bookings b
                 WHERE b.event_id = events.id
                   AND b.status = 'pending_payment'
                   AND b.hold_expires_at IS NOT NULL
                   AND b.hold_expires_at < ?1), 0))
        WHERE id IN (SELECT event_id
                       FROM bookings
                      WHERE status = 'pending_payment'
                        AND hold_expires_at IS NOT NULL
                        AND hold_expires_at < ?1)`,
    ).bind(at),

    env.DB.prepare(
      `UPDATE bookings
          SET status = 'expired',
              hold_expires_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE status = 'pending_payment'
          AND hold_expires_at IS NOT NULL
          AND hold_expires_at < ?1`,
    ).bind(at),
  ]);

  return expired.meta.changes ?? 0;
}
