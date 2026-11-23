/** No imports beyond types, so tests can run it directly against SQLite. */
export interface PurgeDB { prepare(sql: string): { bind(...v: unknown[]): unknown }; batch(stmts: unknown[]): Promise<unknown> }

/**
 * Nightly clean-up (Technical spec › Server operations, daily cron). One atomic batch:
 * if any statement fails, nothing is purged, so every statement is covered by
 * worker/test/purge.test.mjs against the real migrations.
 */
export const TOMBSTONE_TABLES = ["meals_ingredients", "meals_recipes", "meals_planned", "meals_list_states", "activity", "todos_lists", "todos_items", "todos_mutes"] as const;

export async function purge(env: { DB: PurgeDB }, now = Date.now()) {
  const day = 86_400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM activity WHERE at < ?").bind(now - 90 * day),
    env.DB.prepare("DELETE FROM feedback WHERE updated_at < ?").bind(now - 365 * day),
    env.DB.prepare("DELETE FROM audit_log WHERE at < ?").bind(now - 365 * day),
    // Announcements that ended more than 90 days ago, with their dismissals (admin lists the last 90 days).
    env.DB.prepare("DELETE FROM announcement_dismissals WHERE announcement_id IN (SELECT id FROM announcements WHERE ends_at < ?)").bind(now - 90 * day),
    env.DB.prepare("DELETE FROM announcements WHERE ends_at < ?").bind(now - 90 * day),
    // To-dos: reminder bookkeeping older than 3 days; one-time items done more than 37 days ago (the app
    // stops showing them 7 days after they're ticked; this just keeps the table small).
    env.DB.prepare("DELETE FROM todos_sent WHERE at < ?").bind(now - 3 * day),
    env.DB.prepare("DELETE FROM todos_items WHERE done_at IS NOT NULL AND done_at < ? AND repeat IS NULL").bind(now - 37 * day),
    env.DB.prepare("UPDATE households SET invite_code = NULL, invite_expires_at = NULL WHERE invite_expires_at < ?").bind(now),
    // One-time admin sign-in codes are single-use and expire in 10 minutes; expired ones go.
    env.DB.prepare("DELETE FROM admin_signin_codes WHERE expires_at < ?").bind(now),
    // List states for meals that no longer exist have nothing to attach to any more.
    // A meal's tombstone is purged below, in the same run, so a state orphaned by it is
    // picked up the next night, once the meal row itself is gone.
    env.DB.prepare("DELETE FROM meals_list_states WHERE meal_id IS NOT NULL AND meal_id NOT IN (SELECT id FROM meals_planned)").bind(),
    // First raise each household's purge_floor to the highest version being purged, so a device
    // whose cursor is older than that resyncs from scratch instead of keeping ghost rows.
    ...TOMBSTONE_TABLES.map((t) => env.DB.prepare(
      `UPDATE households SET purge_floor = MAX(purge_floor, (SELECT MAX(version) FROM ${t} WHERE ${t}.household_id = households.id AND deleted = 1 AND deleted_at < ?))
       WHERE EXISTS (SELECT 1 FROM ${t} WHERE ${t}.household_id = households.id AND deleted = 1 AND deleted_at < ?)`).bind(now - 30 * day, now - 30 * day)),
    ...TOMBSTONE_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE deleted = 1 AND deleted_at < ?`).bind(now - 30 * day)),
    env.DB.prepare("DELETE FROM households WHERE deleted_at IS NOT NULL AND deleted_at < ?").bind(now - 30 * day),
  ]);
}
