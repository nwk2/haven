import { Hono } from "hono";
import { sendTo, vapidOf } from "./notify";
import { finishGoogle, startGoogle } from "./auth/google";
import { clearCookie, createSession, readSession, type SessionUser } from "./auth/session";
import { newId, randomToken, sha256 } from "./crypto";
import type { Env } from "./env";
import { admin, recordUsage } from "./admin";
import { purge } from "./purge";

export { Household } from "./household";
export { Limiter } from "./limiter";

type App = { Bindings: Env; Variables: { user: SessionUser } };
const app = new Hono<App>();

// ── Sign-in (PRD › Sign-in; Technical spec › Sign-in) ──
app.get("/auth/google", async (c) => {
  const { url, state, verifier } = await startGoogle(c.env, new URL(c.req.url).origin);
  c.header("Set-Cookie", `__Host-haven_oauth=${state}.${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return c.redirect(url);
});

app.get("/auth/google/callback", async (c) => {
  const url = new URL(c.req.url);
  const saved = c.req.header("cookie")?.match(/__Host-haven_oauth=([^;]+)/)?.[1];
  const [state, verifier] = saved?.split(".") ?? [];
  if (!state || state !== url.searchParams.get("state") || !url.searchParams.get("code")) {
    return c.redirect("/login?error=cancelled");
  }
  const profile = await finishGoogle(c.env, url.origin, url.searchParams.get("code")!, verifier);
  const existing = await c.env.DB.prepare("SELECT id, suspended_at FROM users WHERE google_sub = ?").bind(profile.sub).first<{ id: string; suspended_at: number | null }>();
  if (existing?.suspended_at) return c.redirect("/login?error=suspended");
  const userId = existing?.id ?? newId();
  if (existing) {
    await c.env.DB.prepare("UPDATE users SET email = ?, name = ?, photo_url = ? WHERE id = ?").bind(profile.email, profile.name, profile.picture ?? null, userId).run();
  } else {
    await c.env.DB.prepare("INSERT INTO users (id, google_sub, email, name, photo_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, profile.sub, profile.email, profile.name, profile.picture ?? null, Date.now()).run();
  }
  c.header("Set-Cookie", await createSession(c.env, userId, c.req.header("user-agent") ?? ""), { append: true });
  c.header("Set-Cookie", "__Host-haven_oauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax", { append: true });
  return c.redirect("/login/callback");
});

// ── Everything under /api needs a session and, for writes, the anti-forgery header ──
app.use("/api/*", async (c, next) => {
  const user = await readSession(c.env, c.req.header("cookie") ?? null);
  if (!user) return c.json({ error: "signed_out" }, 401);
  if (c.req.method !== "GET" && c.req.header("x-haven") !== "1") return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  await next();
});

app.get("/api/me", async (c) => {
  const u = c.get("user");
  const prefs = await c.env.DB.prepare("SELECT theme, mode, photo_url, removed_notice FROM users WHERE id = ?").bind(u.id).first();
  const household = u.household_id
    ? await c.env.DB.prepare("SELECT id, name, timezone, measurement, default_servings, enabled_modules FROM households WHERE id = ? AND deleted_at IS NULL").bind(u.household_id).first()
    : null;
  const unread = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND user_unread = 1").bind(u.id).first<{ n: number }>();
  const deletedHousehold = household ? null
    : await c.env.DB.prepare("SELECT id, name, deleted_at FROM households WHERE owner_id = ? AND deleted_at IS NOT NULL").bind(u.id).first();
  const role = household ? (await c.env.DB.prepare("SELECT role FROM members WHERE household_id = ? AND user_id = ?").bind(u.household_id, u.id).first<{ role: string }>())?.role : null;
  const flags = Object.fromEntries((await c.env.DB.prepare("SELECT key, value FROM flags").all<{ key: string; value: string }>()).results.map((f) => [f.key, JSON.parse(f.value)]));
  // Announcements live now or starting within a day (the console shows each at its start and hides it
  // at its end without asking again), minus the ones this person dismissed (decision, Nov 2026).
  const now = Date.now();
  const announcements = (await c.env.DB.prepare(
    `SELECT a.id, a.kind, a.title, a.text, a.dismissible, a.starts_at, a.ends_at FROM announcements a
     WHERE a.ends_at > ?1 AND a.starts_at <= ?2
       AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = ?3)
     ORDER BY a.starts_at DESC LIMIT 20`,
  ).bind(now, now + 86_400_000, u.id).all()).results;
  return c.json({ features: { photos: !!c.env.PHOTOS }, flags, announcements, user: { ...u, ...prefs, role }, household, deletedHousehold, unreadReplies: unread?.n ?? 0, protocol: Number(c.env.PROTOCOL_VERSION) });
});

// ── Notifications (PRD › To-dos plan › Notifications) ──
// Settings › Notifications: whether push is set up, the public key a device subscribes with, and choices.
app.get("/api/notifications", async (c) => {
  const u = c.get("user");
  const p = await c.env.DB.prepare("SELECT digest, given FROM notify_prefs WHERE user_id = ?").bind(u.id).first<{ digest: number; given: number }>();
  const devices = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(u.id).first<{ n: number }>();
  return c.json({ enabled: !!vapidOf(c.env), publicKey: c.env.VAPID_PUBLIC_KEY ?? null, digest: p?.digest !== 0, given: p?.given !== 0, devices: devices?.n ?? 0 });
});
app.put("/api/notifications", async (c) => {
  const b = await c.req.json<{ digest?: boolean; given?: boolean }>();
  const u = c.get("user");
  const cur = await c.env.DB.prepare("SELECT digest, given FROM notify_prefs WHERE user_id = ?").bind(u.id).first<{ digest: number; given: number }>();
  const digest = b.digest ?? (cur?.digest !== 0), given = b.given ?? (cur?.given !== 0);
  await c.env.DB.prepare("INSERT INTO notify_prefs (user_id, digest, given) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET digest = excluded.digest, given = excluded.given").bind(u.id, digest ? 1 : 0, given ? 1 : 0).run();
  return c.json({ ok: true });
});
// This device allowed notifications (or its subscription changed).
app.post("/api/push/subscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
  if (!b.endpoint?.startsWith("https://") || !b.keys?.p256dh || !b.keys?.auth || b.endpoint.length > 1000) return c.json({ error: "bad_request" }, 400);
  await c.env.DB.prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth")
    .bind(b.endpoint, c.get("user").id, b.keys.p256dh, b.keys.auth, Date.now()).run();
  return c.json({ ok: true });
});
app.delete("/api/push/subscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string }>().catch(() => ({} as { endpoint?: string }));
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(b.endpoint ?? "", c.get("user").id).run();
  return c.json({ ok: true });
});
// "Send a test notification" (5 an hour).
app.post("/api/push/test", async (c) => {
  const u = c.get("user");
  if (!(await allowWindow(c.env, `push-test:${u.id}`, 5, 3_600_000))) return c.json({ error: "too_many" }, 429);
  const n = await sendTo(c.env, [u.id], "test", { title: "Notifications are on", body: "This is how Haven will remind you.", url: "/settings/notifications" });
  return c.json({ sent: n });
});

// Dismiss an announcement for this person (every device); DELETE undoes it.
app.post("/api/announcements/:id/dismiss", async (c) => {
  const u = c.get("user");
  const a = await c.env.DB.prepare("SELECT dismissible FROM announcements WHERE id = ?").bind(c.req.param("id")).first<{ dismissible: number }>();
  if (!a) return c.json({ error: "not_found" }, 404);
  if (!a.dismissible) return c.json({ error: "not_dismissible" }, 400);
  await c.env.DB.prepare("INSERT OR IGNORE INTO announcement_dismissals (user_id, announcement_id, at) VALUES (?, ?, ?)").bind(u.id, c.req.param("id"), Date.now()).run();
  return c.json({ ok: true });
});
app.delete("/api/announcements/:id/dismiss", async (c) => {
  await c.env.DB.prepare("DELETE FROM announcement_dismissals WHERE user_id = ? AND announcement_id = ?").bind(c.get("user").id, c.req.param("id")).run();
  return c.json({ ok: true });
});

app.post("/api/households", async (c) => {
  const u = c.get("user");
  if (u.household_id) return c.json({ error: "already_in_household" }, 409);
  const { name } = await c.req.json<{ name: string }>();
  const country = (c.req.raw as unknown as { cf?: { country?: string } }).cf?.country;
  const us = country === "US";
  const id = newId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO households (id, name, owner_id, timezone, measurement, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(id, name.trim().slice(0, 60), u.id, c.req.header("x-haven-tz") ?? "UTC", us ? "us" : "metric", now),
    c.env.DB.prepare("INSERT INTO members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(id, u.id, now),
    c.env.DB.prepare("UPDATE users SET household_id = ? WHERE id = ?").bind(id, u.id),
  ]);
  return c.json({ id });
});

app.get("/api/invite", async (c) => {
  const u = c.get("user");
  const h = await c.env.DB.prepare("SELECT invite_code, invite_expires_at FROM households WHERE id = ?").bind(u.household_id).first<{ invite_code: string | null; invite_expires_at: number | null }>();
  if (!h?.invite_code || (h.invite_expires_at ?? 0) < Date.now()) return c.json({ link: null });
  return c.json({ link: `${new URL(c.req.url).origin}/join/${h.invite_code}`, expiresAt: h.invite_expires_at });
});

app.post("/api/invite/reset", async (c) => {
  const u = c.get("user");
  if (!(await isOwner(c.env, u))) return c.json({ error: "owner_only" }, 403);
  const code = randomToken(16);                               // 128 bits, 22 characters
  const expiresAt = Date.now() + 7 * 86_400_000;
  await c.env.DB.prepare("UPDATE households SET invite_code = ?, invite_expires_at = ? WHERE id = ?").bind(code, expiresAt, u.household_id).run();
  return c.json({ link: `${new URL(c.req.url).origin}/join/${code}`, expiresAt });
});

app.post("/api/join", async (c) => {
  const u = c.get("user");
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  if (!(await allow(c.env, `join-ip:${ip}`, 10)) || !(await allow(c.env, `join-user:${u.id}`, 5))) return c.json({ error: "too_many_tries" }, 429);
  const { code } = await c.req.json<{ code: string }>();
  const h = await c.env.DB.prepare("SELECT id, name, invite_expires_at FROM households WHERE invite_code = ? AND deleted_at IS NULL")
    .bind(String(code ?? "")).first<{ id: string; name: string; invite_expires_at: number }>();
  // Wrong and expired codes get the same answer, so codes can't be probed.
  if (!h || h.invite_expires_at < Date.now()) return c.json({ error: "invite_expired" }, 410);
  if (u.household_id === h.id) return c.json({ id: h.id });
  if (u.household_id) {
    const current = await c.env.DB.prepare("SELECT name FROM households WHERE id = ?").bind(u.household_id).first<{ name: string }>();
    return c.json({ error: "already_in_household", joining: h.name, current: current?.name, owner: await isOwner(c.env, u) }, 409);
  }
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE household_id = ?").bind(h.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 6) return c.json({ error: "household_full", joining: h.name }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO members (household_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(h.id, u.id, Date.now()),
    c.env.DB.prepare("UPDATE users SET household_id = ? WHERE id = ?").bind(h.id, u.id),
  ]);
  return c.json({ id: h.id });
});

/** Fixed one-hour windows, counted in a small Durable Object (Technical spec › Invites). */
async function allow(env: Env, key: string, perHour: number) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const r = await stub.fetch("https://limiter/hit", { method: "POST", body: JSON.stringify({ limit: perHour, windowMs: 3_600_000 }) });
  return ((await r.json()) as { ok: boolean }).ok;
}

// ── Account and household (PRD › Roles; Settings) ──
const isOwner = async (env: Env, u: SessionUser) =>
  !!u.household_id && (await env.DB.prepare("SELECT 1 FROM households WHERE id = ? AND owner_id = ?").bind(u.household_id, u.id).first());

app.patch("/api/me", async (c) => {
  const u = c.get("user");
  const b = await c.req.json<{ theme?: string; mode?: string }>();
  if (b.theme && !["market", "tomato", "night"].includes(b.theme)) return c.json({ error: "bad_theme" }, 400);
  if (b.mode && !["system", "light", "dark"].includes(b.mode)) return c.json({ error: "bad_mode" }, 400);
  await c.env.DB.prepare("UPDATE users SET theme = COALESCE(?, theme), mode = COALESCE(?, mode) WHERE id = ?").bind(b.theme ?? null, b.mode ?? null, u.id).run();
  c.env.EVENTS?.writeDataPoint({ blobs: ["theme_changed", b.theme ?? "", b.mode ?? ""], indexes: [await sha256(u.household_id ?? u.id)] });
  return c.json({ ok: true });
});

app.get("/api/members", async (c) => {
  const u = c.get("user");
  if (!u.household_id) return c.json({ members: [] });
  const r = await c.env.DB.prepare(
    "SELECT m.user_id AS id, u.name, u.photo_url, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.joined_at",
  ).bind(u.household_id).all();
  return c.json({ members: r.results });
});

app.patch("/api/household", async (c) => {
  const u = c.get("user");
  if (!(await isOwner(c.env, u))) return c.json({ error: "owner_only" }, 403);
  const b = await c.req.json<Record<string, unknown>>();
  const allowed: Record<string, (v: unknown) => boolean> = {
    name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 60,
    timezone: (v) => typeof v === "string" && v.length < 64,
    measurement: (v) => ["metric", "us"].includes(v as string),
    default_servings: (v) => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20),
    enabled_modules: (v) => Array.isArray(v) && v.every((x) => x === "meals" || x === "todos") && new Set(v).size === v.length,
  };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!allowed[k]?.(v)) return c.json({ error: `bad_${k}` }, 400);
    sets.push(`${k} = ?`); vals.push(k === "enabled_modules" ? JSON.stringify(v) : v);
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE households SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, u.household_id).run();
  return c.json({ ok: true });
});

app.post("/api/members/:id/remove", async (c) => {
  const u = c.get("user"); const target = c.req.param("id");
  if (!(await isOwner(c.env, u)) || target === u.id) return c.json({ error: "owner_only" }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM members WHERE household_id = ? AND user_id = ?").bind(u.household_id, target),
    c.env.DB.prepare("UPDATE users SET household_id = NULL, removed_notice = (SELECT json_object('household', name, 'at', ?, 'by', ?) FROM households WHERE id = ?) WHERE id = ? AND household_id = ?")
      .bind(Date.now(), u.name, u.household_id, target, u.household_id),
  ]);
  return c.json({ ok: true });
});

app.post("/api/ownership", async (c) => {
  const u = c.get("user");
  const { userId } = await c.req.json<{ userId: string }>();
  if (!(await isOwner(c.env, u)) || userId === u.id) return c.json({ error: "owner_only" }, 403);
  const isMember = await c.env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? AND user_id = ?").bind(u.household_id, userId).first();
  if (!isMember) return c.json({ error: "not_a_member" }, 400);
  await c.env.DB.batch([   // demote first: the unique index allows one owner at a time
    c.env.DB.prepare("UPDATE members SET role = 'member' WHERE household_id = ? AND user_id = ?").bind(u.household_id, u.id),
    c.env.DB.prepare("UPDATE members SET role = 'owner' WHERE household_id = ? AND user_id = ?").bind(u.household_id, userId),
    c.env.DB.prepare("UPDATE households SET owner_id = ? WHERE id = ?").bind(userId, u.household_id),
  ]);
  return c.json({ ok: true });
});

/** Removes a user from their household; deletes the household (30-day window) if they were the last member. */
async function leave(env: Env, u: SessionUser) {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE household_id = ?").bind(u.household_id).first<{ n: number }>())?.n ?? 0;
  const stmts = [
    env.DB.prepare("DELETE FROM members WHERE household_id = ? AND user_id = ?").bind(u.household_id, u.id),
    env.DB.prepare("UPDATE users SET household_id = NULL WHERE id = ?").bind(u.id),
  ];
  if (n <= 1) stmts.push(env.DB.prepare("UPDATE households SET deleted_at = ? WHERE id = ?").bind(Date.now(), u.household_id));
  await env.DB.batch(stmts);
}

app.post("/api/leave", async (c) => {
  const u = c.get("user");
  if (!u.household_id) return c.json({ ok: true });
  const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE household_id = ?").bind(u.household_id).first<{ n: number }>())?.n ?? 0;
  if ((await isOwner(c.env, u)) && n > 1) return c.json({ error: "transfer_first" }, 409);
  await leave(c.env, u);
  return c.json({ ok: true });
});

app.post("/api/household/delete", async (c) => {
  const u = c.get("user");
  if (!(await isOwner(c.env, u))) return c.json({ error: "owner_only" }, 403);
  const { confirm } = await c.req.json<{ confirm: string }>();
  const h = await c.env.DB.prepare("SELECT name FROM households WHERE id = ?").bind(u.household_id).first<{ name: string }>();
  if (confirm !== h?.name) return c.json({ error: "name_mismatch" }, 400);
  await c.env.DB.prepare("UPDATE households SET deleted_at = ? WHERE id = ?").bind(Date.now(), u.household_id).run();
  return c.json({ ok: true });
});

app.post("/api/household/restore", async (c) => {
  const u = c.get("user");
  const r = await c.env.DB.prepare("UPDATE households SET deleted_at = NULL WHERE owner_id = ? AND deleted_at IS NOT NULL").bind(u.id).run();
  return c.json({ ok: r.meta.changes > 0 });
});

app.post("/api/sessions/revoke", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(c.get("user").id).run();
  c.header("Set-Cookie", clearCookie);
  return c.json({ ok: true });
});

app.get("/api/export", async (c) => {
  const u = c.get("user");
  const user = await c.env.DB.prepare("SELECT id, email, name, photo_url, theme, mode, created_at FROM users WHERE id = ?").bind(u.id).first();
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), user };
  if (u.household_id) {
    out.household = await c.env.DB.prepare("SELECT id, name, timezone, measurement, default_servings, created_at FROM households WHERE id = ?").bind(u.household_id).first();
    for (const t of ["meals_ingredients", "meals_recipes", "meals_planned", "meals_list_states"]) {
      out[t] = (await c.env.DB.prepare(`SELECT * FROM ${t} WHERE household_id = ? AND deleted = 0`).bind(u.household_id).all()).results;
    }
  }
  c.header("Content-Disposition", `attachment; filename="haven-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(out);
});

app.post("/api/account/delete", async (c) => {
  const u = c.get("user");
  const { confirm } = await c.req.json<{ confirm: string }>();
  if (confirm?.toLowerCase() !== u.email.toLowerCase()) return c.json({ error: "email_mismatch" }, 400);
  if (u.household_id && (await isOwner(c.env, u))) {
    const next = await c.env.DB.prepare("SELECT user_id FROM members WHERE household_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1")
      .bind(u.household_id, u.id).first<{ user_id: string }>();
    if (next) {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE members SET role = 'member' WHERE household_id = ? AND user_id = ?").bind(u.household_id, u.id),
        c.env.DB.prepare("UPDATE members SET role = 'owner' WHERE household_id = ? AND user_id = ?").bind(u.household_id, next.user_id),
        c.env.DB.prepare("UPDATE households SET owner_id = ? WHERE id = ?").bind(next.user_id, u.household_id),
      ]);
    }
  }
  if (u.household_id) {
    const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE household_id = ?").bind(u.household_id).first<{ n: number }>())?.n ?? 0;
    if (n <= 1) {
      // Decision (Nov 2026): a sole member deleting their account deletes the household and all its data now.
      // Child tables cascade from households.
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE users SET household_id = NULL WHERE household_id = ?").bind(u.household_id),
        c.env.DB.prepare("DELETE FROM households WHERE id = ?").bind(u.household_id),
      ]);
    } else await leave(c.env, u);
  }
  // Households they own but deleted earlier (in the 30-day window) go too.
  await c.env.DB.prepare("DELETE FROM households WHERE owner_id = ? AND deleted_at IS NOT NULL").bind(u.id).run();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
    c.env.DB.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").bind(u.id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
  ]);
  c.header("Set-Cookie", clearCookie);
  return c.json({ ok: true });
});

// ── Feedback (PRD › Admin › Replies inside Haven) ──
const userStatus = (status: string, hasAdmin: boolean) => (hasAdmin ? "Replied" : status === "new" ? "Sent" : "Read");

app.get("/api/feedback", async (c) => {
  const u = c.get("user");
  const r = await c.env.DB.prepare(
    `SELECT f.id, f.kind, f.status, f.user_unread, f.created_at, f.updated_at,
       (SELECT text FROM feedback_messages m WHERE m.feedback_id = f.id ORDER BY created_at LIMIT 1) AS first,
       EXISTS (SELECT 1 FROM feedback_messages m WHERE m.feedback_id = f.id AND m.author = 'admin') AS has_admin
     FROM feedback f WHERE f.user_id = ? ORDER BY f.updated_at DESC LIMIT 50`).bind(u.id).all<{ status: string; has_admin: number }>();
  return c.json({ items: r.results.map((x) => ({ ...x, label: userStatus(x.status, !!x.has_admin) })) });
});

app.get("/api/feedback/:id", async (c) => {
  const u = c.get("user");
  const f = await c.env.DB.prepare("SELECT id, kind, status, created_at FROM feedback WHERE id = ? AND user_id = ?").bind(c.req.param("id"), u.id).first<{ id: string; status: string }>();
  if (!f) return c.json({ error: "not_found" }, 404);
  const msgs = await c.env.DB.prepare("SELECT id, author, text, created_at FROM feedback_messages WHERE feedback_id = ? ORDER BY created_at").bind(f.id).all<{ author: string }>();
  await c.env.DB.prepare("UPDATE feedback SET user_unread = 0 WHERE id = ?").bind(f.id).run();
  return c.json({ ...f, label: userStatus(f.status, msgs.results.some((m) => m.author === "admin")), messages: msgs.results });
});

app.post("/api/feedback", async (c) => {
  const u = c.get("user");
  if (!(await allowWindow(c.env, `feedback:${u.id}`, 10, 86_400_000))) return c.json({ error: "too_many" }, 429);
  const b = await c.req.json<{ kind: string; text: string; device?: Record<string, unknown> | null }>();
  if (!["broken", "idea", "question"].includes(b.kind) || !b.text?.trim()) return c.json({ error: "bad_request" }, 400);
  const id = newId(); const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO feedback (id, user_id, household_id, kind, device, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, u.id, u.household_id, b.kind, b.device ? JSON.stringify(b.device).slice(0, 2000) : null, now, now),
    c.env.DB.prepare("INSERT INTO feedback_messages (id, feedback_id, author, text, created_at) VALUES (?, ?, 'user', ?, ?)").bind(newId(), id, b.text.trim().slice(0, 5000), now),
  ]);
  c.executionCtx.waitUntil(notifyAdmin(c.env, `New ${b.kind} feedback from ${u.name}`, b.text.trim()));
  return c.json({ id });
});

app.post("/api/feedback/:id/messages", async (c) => {
  const u = c.get("user");
  const { text } = await c.req.json<{ text: string }>();
  const f = await c.env.DB.prepare("SELECT id FROM feedback WHERE id = ? AND user_id = ?").bind(c.req.param("id"), u.id).first();
  if (!f || !text?.trim()) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO feedback_messages (id, feedback_id, author, text, created_at) VALUES (?, ?, 'user', ?, ?)").bind(newId(), c.req.param("id"), text.trim().slice(0, 5000), now),
    c.env.DB.prepare("UPDATE feedback SET status = 'new', updated_at = ? WHERE id = ?").bind(now, c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

async function allowWindow(env: Env, key: string, limit: number, windowMs: number) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const r = await stub.fetch("https://limiter/hit", { method: "POST", body: JSON.stringify({ limit, windowMs }) });
  return ((await r.json()) as { ok: boolean }).ok;
}

/** Email to the admin. Needs a send_email binding named EMAIL (see build notes: requires a domain on Cloudflare). */
async function notifyAdmin(env: Env, subject: string, body: string) {
  if (!env.EMAIL || !env.ADMIN_EMAIL || !env.EMAIL_FROM) return;
  const { EmailMessage } = await import("cloudflare:email");
  const raw = [`From: Haven <${env.EMAIL_FROM}>`, `To: ${env.ADMIN_EMAIL}`, `Subject: ${subject.replace(/[\r\n]/g, " ")}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, env.ADMIN_EMAIL, raw));
}

// ── Recipe photos in R2 (Technical spec › Photos) ──
app.put("/api/photos/:recipeId/:kind", async (c) => {
  const u = c.get("user");
  if (!c.env.PHOTOS) return c.json({ error: "photos_off" }, 404);   // decision Nov 2026: photos off until R2 is enabled
  if (!u.household_id) return c.json({ error: "no_household" }, 409);
  const kind = c.req.param("kind");
  if (!["full", "thumb"].includes(kind) || c.req.header("content-type") !== "image/webp") return c.json({ error: "bad_request" }, 400);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 1_000_000) return c.json({ error: "too_large" }, 413);
  const key = `households/${u.household_id}/recipes/${c.req.param("recipeId")}/${c.req.query("id") ?? newId()}-${kind}.webp`;
  await c.env.PHOTOS.put(key, body, { httpMetadata: { contentType: "image/webp", cacheControl: "private, max-age=31536000, immutable" } });
  return c.json({ key });
});
app.get("/api/photos/*", async (c) => {
  const u = c.get("user");
  if (!c.env.PHOTOS) return c.json({ error: "photos_off" }, 404);
  const key = c.req.path.slice("/api/photos/".length);
  if (!u.household_id || !key.startsWith(`households/${u.household_id}/`)) return c.json({ error: "not_found" }, 404);   // only your household's photos
  const obj = await c.env.PHOTOS.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "image/webp", "cache-control": "private, max-age=31536000, immutable" } });
});

app.post("/api/removed-notice/dismiss", async (c) => {
  await c.env.DB.prepare("UPDATE users SET removed_notice = NULL WHERE id = ?").bind(c.get("user").id).run();
  return c.json({ ok: true });
});

// ── Sync: forward to the household's Durable Object ──
const toHousehold = (c: { env: Env; get: (k: "user") => SessionUser }, req: Request) => {
  const u = c.get("user");
  if (!u.household_id) return new Response("no household", { status: 409 });
  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(u.household_id));
  const headers = new Headers(req.headers);
  headers.set("x-haven-user", u.id);
  headers.set("x-haven-household", u.household_id);
  return stub.fetch(new Request(req, { headers }));
};
app.get("/api/live", (c) => toHousehold(c, c.req.raw));
app.post("/api/sync", (c) => toHousehold(c, c.req.raw));

app.post("/api/signout", (c) => { c.header("Set-Cookie", clearCookie); return c.json({ ok: true }); });

export default {
  // ADMIN_MODE = "1": the admin Worker (haven-admin.<account>.workers.dev) serves only admin routes.
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const handler = env.ADMIN_MODE === "1" ? admin : app;
    const url = new URL(req.url);
    // Google returns to "/" (registered redirect URI). With a state it's our sign-in callback.
    if (url.pathname === "/" && url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error"))) {
      if (url.searchParams.has("error")) return Response.redirect(`${url.origin}/${env.ADMIN_MODE === "1" ? "sign-in" : "login"}?error=cancelled`, 302);
      url.pathname = "/auth/google/callback";
      return handler.fetch(new Request(url, req), env, ctx);
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return handler.fetch(req, env, ctx);
    return env.ASSETS.fetch(req);   // app files; unknown paths fall back to index.html (single-page app)
  },
  async scheduled(event: ScheduledController, env: Env) {
    if (event.cron === "0 3 * * *") await purge(env);
    if (event.cron === "0 12,20 * * *") await recordUsage(env);
  },
} satisfies ExportedHandler<Env>;
