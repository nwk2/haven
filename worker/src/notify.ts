import { dateInZone, planReminders, type RItem, type RList } from "@haven/todos-core";
import type { Env } from "./env";
import { sendPush, type PushSub, type Vapid } from "./push";

/**
 * Push notifications (PRD › To-dos plan › Notifications). Each device that allowed notifications has a
 * subscription; each person has preferences (morning digest, "someone gave you a to-do"). The household's
 * sync object runs this from its alarm, so reminders fire on time without polling.
 */
// The VAPID subject identifies this server to Apple's and Google's push services. Haven's URL, not a
// personal email, so no one's address goes out with every notification (as in dont-ngiao).
export const DEFAULT_VAPID_SUBJECT = "https://haven.wk-io.workers.dev";
export const vapidOf = (env: Env): Vapid | null =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT } : null;

export type Kind = "reminder" | "digest" | "given" | "test";
export interface Message { title: string; body: string; url: string; tag?: string }

/** Sends to every device of these people, honouring their choices; drops expired subscriptions. */
export async function sendTo(env: Env, userIds: string[], kind: Kind, msg: Message): Promise<number> {
  const v = vapidOf(env); if (!v || !userIds.length) return 0;
  const ids = [...new Set(userIds)];
  const marks = ids.map(() => "?").join(",");
  const prefs = new Map((await env.DB.prepare(`SELECT user_id, digest, given FROM notify_prefs WHERE user_id IN (${marks})`).bind(...ids).all<{ user_id: string; digest: number; given: number }>()).results.map((r) => [r.user_id, r]));
  const wanted = ids.filter((u) => kind === "digest" ? prefs.get(u)?.digest !== 0 : kind === "given" ? prefs.get(u)?.given !== 0 : true);
  if (!wanted.length) return 0;
  const subs = (await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${wanted.map(() => "?").join(",")})`).bind(...wanted).all<PushSub>()).results;
  let sent = 0;
  const results = await Promise.all(subs.map(async (s) => [s, await sendPush(s, { ...msg, tag: msg.tag ?? kind }, v, kind === "reminder" ? "high" : "normal")] as const));
  for (const [s, r] of results) {
    if (r === "gone") await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(s.endpoint).run();
    else if (r === "ok") { sent++; await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?").bind(Date.now(), s.endpoint).run(); }
  }
  return sent;
}

/** Sends any reminders due now for one household and returns when the next one is due. */
export async function runReminders(env: Env, householdId: string, now = Date.now()): Promise<number | null> {
  const h = await env.DB.prepare("SELECT timezone FROM households WHERE id = ? AND deleted_at IS NULL").bind(householdId).first<{ timezone: string }>();
  if (!h) return null;
  const on = (await env.DB.prepare("SELECT value FROM flags WHERE key = 'module_todos_enabled'").first<{ value: string }>())?.value === "true";
  const enabled = (await env.DB.prepare("SELECT enabled_modules FROM households WHERE id = ?").bind(householdId).first<{ enabled_modules: string }>())?.enabled_modules ?? "[]";
  if (!on || !JSON.parse(enabled).includes("todos")) return null;
  const today = dateInZone(now, h.timezone);
  const [lists, items, members, mutes, sent] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, checklist, deleted FROM todos_lists WHERE household_id = ? AND deleted = 0").bind(householdId),
    // Open items with a date; anything dated more than a year ahead can wait.
    env.DB.prepare("SELECT id, list_id, title, due_date, due_time, assignee_id, done_at, deleted FROM todos_items WHERE household_id = ? AND deleted = 0 AND done_at IS NULL AND due_date IS NOT NULL AND due_date <= date(?, '+366 days')").bind(householdId, today),
    env.DB.prepare("SELECT user_id FROM members WHERE household_id = ?").bind(householdId),
    env.DB.prepare("SELECT user_id, list_id FROM todos_mutes WHERE household_id = ? AND deleted = 0").bind(householdId),
    env.DB.prepare("SELECT key FROM todos_sent WHERE household_id = ? AND at > ?").bind(householdId, now - 3 * 86_400_000),
  ]);
  const plan = planReminders({
    tz: h.timezone, now,
    lists: lists.results as unknown as RList[], items: items.results as unknown as RItem[],
    members: (members.results as { user_id: string }[]).map((m) => m.user_id),
    mutes: mutes.results as { user_id: string; list_id: string }[],
    sent: new Set((sent.results as { key: string }[]).map((r) => r.key)),
  });
  const keys = new Set<string>();
  for (const r of plan.due) { await sendTo(env, r.users, r.key.startsWith("digest|") ? "digest" : "reminder", { title: r.title, body: r.body, url: r.url, tag: r.key }); keys.add(r.key); }
  if (keys.size) await env.DB.batch([...keys].map((k) => env.DB.prepare("INSERT OR IGNORE INTO todos_sent (household_id, key, at) VALUES (?, ?, ?)").bind(householdId, k, now)));
  return plan.nextAt;
}

/** "Mira gave you 'Call the plumber'": sent when someone else assigns an item to you. */
export async function notifyGiven(env: Env, householdId: string, itemId: string, assigneeId: string, actorId: string) {
  if (assigneeId === actorId) return;
  const [item, actor] = await env.DB.batch([
    env.DB.prepare("SELECT title, list_id FROM todos_items WHERE id = ? AND household_id = ? AND deleted = 0").bind(itemId, householdId),
    env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(actorId),
  ]);
  const it = item.results[0] as { title: string; list_id: string } | undefined; if (!it) return;
  const name = ((actor.results[0] as { name?: string } | undefined)?.name ?? "Someone").split(" ")[0];
  await sendTo(env, [assigneeId], "given", { title: `${name} gave you a to-do`, body: it.title, url: `/m/todos/list/${it.list_id}`, tag: `given|${itemId}` });
}
