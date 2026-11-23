import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { Hono } from "hono";
import { finishGoogle, startGoogle } from "./auth/google";
import { newId, randomToken, sha256 } from "./crypto";
import type { Env } from "./env";

/**
 * Admin site (PRD › Admin; Technical spec › Admin site). Same Worker code, deployed a second
 * time with ADMIN_MODE = "1". Google sign-in + passkey; never reads household content.
 */
const COOKIE = "__Host-haven_admin";
// Sessions (decision, Nov 2026): signed in on a device for 90 days, extended on use (at most one write an
// hour, and the cookie is renewed with it). Sensitive actions still need the passkey within 15 minutes.
const DAYS_90 = 90 * 86_400_000;
const STEP_UP = 15 * 60_000;
const cookieFor = (token: string, maxAgeMs: number) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(maxAgeMs / 1000)}`;
const LIMITS = { daily: { worker_requests: 100_000, do_requests: 100_000, d1_rows_written: 100_000, d1_rows_read: 5_000_000 } };

interface AdminSession { token_hash: string; passkey_at: number; challenge: string | null; expires_at: number }
type A = { Bindings: Env; Variables: { s: AdminSession } };
export const admin = new Hono<A>();

const tokenOf = (cookie: string | undefined) => cookie?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
/** Returns the admin session if it's valid; the /api middleware renews it (90 days, sliding). */
async function session(env: Env, cookie: string | undefined): Promise<AdminSession | null> {
  const t = tokenOf(cookie); if (!t) return null;
  return env.DB.prepare("SELECT token_hash, passkey_at, challenge, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256(t), Date.now()).first<AdminSession>();
}
async function audit(env: Env, action: string, targetType: string, targetId: string | null, detail?: unknown) {
  await env.DB.prepare("INSERT INTO audit_log (id, at, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(), Date.now(), action, targetType, targetId, detail ? JSON.stringify(detail) : null).run();
}
async function limited(env: Env, key: string, limit: number) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
  const r = await stub.fetch("https://limiter/hit", { method: "POST", body: JSON.stringify({ limit, windowMs: 3_600_000 }) });
  return !((await r.json()) as { ok: boolean }).ok;
}

// ── Google step ──
admin.get("/auth/google", async (c) => {
  if (await limited(c.env, `admin-ip:${c.req.header("cf-connecting-ip") ?? "local"}`, 20)) return c.redirect("/sign-in?error=too_many");
  const { url, state, verifier } = await startGoogle(c.env, new URL(c.req.url).origin);
  c.header("Set-Cookie", `__Host-haven_oauth=${state}.${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return c.redirect(url);
});

admin.get("/auth/google/callback", async (c) => {
  const url = new URL(c.req.url);
  const [state, verifier] = c.req.header("cookie")?.match(/__Host-haven_oauth=([^;]+)/)?.[1]?.split(".") ?? [];
  if (!state || state !== url.searchParams.get("state")) return c.redirect("/sign-in?error=cancelled");
  const p = await finishGoogle(c.env, url.origin, url.searchParams.get("code")!, verifier).catch(() => null);
  if (!p) return c.redirect("/sign-in?error=cancelled");
  if (!c.env.ADMIN_EMAIL || p.email.toLowerCase() !== c.env.ADMIN_EMAIL.toLowerCase()) {
    await limited(c.env, `admin-fail:${c.req.header("cf-connecting-ip") ?? "local"}`, 5);
    await audit(c.env, "Admin sign-in refused", "email", p.email);
    return c.redirect(`/denied?email=${encodeURIComponent(p.email)}`);
  }
  const token = randomToken(); const now = Date.now();
  await c.env.DB.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at, passkey_at) VALUES (?, ?, ?, 0)").bind(await sha256(token), now, now + DAYS_90).run();
  c.header("Set-Cookie", cookieFor(token, DAYS_90), { append: true });
  return c.redirect("/sign-in?step=passkey");
});

// Everything under /api needs a Google-verified admin session and the anti-forgery header.
admin.use("/api/*", async (c, next) => {
  const s = await session(c.env, c.req.header("cookie"));
  if (!s) return c.json({ error: "signed_out" }, 401);
  if (c.req.method !== "GET" && c.req.header("x-haven") !== "1") return c.json({ error: "forbidden" }, 403);
  c.set("s", s);
  if (!c.req.path.startsWith("/api/passkey") && !s.passkey_at) return c.json({ error: "passkey_required" }, 401);
  // Sliding 90 days: extend at most once an hour (one write), and renew the cookie with it.
  if (s.expires_at - Date.now() < DAYS_90 - 3_600_000) {
    const token = tokenOf(c.req.header("cookie"))!;
    await c.env.DB.prepare("UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?").bind(Date.now() + DAYS_90, s.token_hash).run();
    s.expires_at = Date.now() + DAYS_90;
    c.header("Set-Cookie", cookieFor(token, DAYS_90), { append: true });
  }
  await next();
});
const fresh = (s: AdminSession) => Date.now() - s.passkey_at < STEP_UP;
const stepUp = (c: { get: (k: "s") => AdminSession; json: (b: unknown, s: 401) => Response }) => (fresh(c.get("s")) ? null : c.json({ error: "passkey_required" }, 401));
const rp = (c: { req: { url: string } }) => { const u = new URL(c.req.url); return { rpID: u.hostname, origin: u.origin }; };

// ── Passkey step (setup on first use) ──
admin.get("/api/passkey/options", async (c) => {
  const keys = (await c.env.DB.prepare("SELECT credential_id FROM admin_passkeys").all<{ credential_id: string }>()).results;
  const { rpID } = rp(c);
  const opts = keys.length && c.req.query("add") !== "1"
    ? await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: keys.map((k) => ({ id: k.credential_id })) })
    : await generateRegistrationOptions({ rpName: "Haven admin", rpID, userName: c.env.ADMIN_EMAIL ?? "admin", userVerification: "required", excludeCredentials: keys.map((k) => ({ id: k.credential_id })) } as Parameters<typeof generateRegistrationOptions>[0]);
  await c.env.DB.prepare("UPDATE admin_sessions SET challenge = ? WHERE token_hash = ?").bind(opts.challenge, c.get("s").token_hash).run();
  return c.json({ mode: keys.length && c.req.query("add") !== "1" ? "authenticate" : keys.length ? "add" : "setup", options: opts });
});

admin.post("/api/passkey/register", async (c) => {
  const s = c.get("s");
  const { setupCode, response, name } = await c.req.json<{ setupCode?: string; response: Parameters<typeof verifyRegistrationResponse>[0]["response"]; name?: string }>();
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_passkeys").first<{ n: number }>())?.n ?? 0;
  if (count === 0 || !s.passkey_at) {
    // First passkey (or recovery): needs the one-time setup code.
    const code = c.env.ADMIN_SETUP_CODE;
    const used = code ? await c.env.DB.prepare("SELECT 1 FROM admin_setup WHERE code_hash = ?").bind(await sha256(code)).first() : true;
    if (!code || used || setupCode !== code) { await audit(c.env, "Admin setup code rejected", "admin", null); return c.json({ error: "bad_setup_code" }, 403); }
  } else if (!fresh(s)) return c.json({ error: "passkey_required" }, 401);
  const { rpID, origin } = rp(c);
  const v = await verifyRegistrationResponse({ response, expectedChallenge: s.challenge ?? "", expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }).catch(() => null);
  if (!v?.verified || !v.registrationInfo) return c.json({ error: "not_verified" }, 400);
  const cred = v.registrationInfo.credential;
  const pk = btoa(String.fromCharCode(...cred.publicKey));
  const stmts = [
    c.env.DB.prepare("INSERT INTO admin_passkeys (credential_id, public_key, counter, name, created_at) VALUES (?, ?, ?, ?, ?)").bind(cred.id, pk, cred.counter, (name ?? "Passkey").slice(0, 40), Date.now()),
    c.env.DB.prepare("UPDATE admin_sessions SET passkey_at = ?, challenge = NULL WHERE token_hash = ?").bind(Date.now(), s.token_hash),
  ];
  if (count === 0 || !s.passkey_at) stmts.push(c.env.DB.prepare("INSERT INTO admin_setup (code_hash, used_at) VALUES (?, ?)").bind(await sha256(setupCode!), Date.now()));
  await c.env.DB.batch(stmts);
  await audit(c.env, count === 0 ? "Admin set up" : "Passkey added", "admin", null, { name });
  return c.json({ ok: true });
});

admin.post("/api/passkey/verify", async (c) => {
  const s = c.get("s");
  const { response } = await c.req.json<{ response: Parameters<typeof verifyAuthenticationResponse>[0]["response"] }>();
  const key = await c.env.DB.prepare("SELECT credential_id, public_key, counter FROM admin_passkeys WHERE credential_id = ?").bind(response.id).first<{ credential_id: string; public_key: string; counter: number }>();
  if (!key) return c.json({ error: "unknown_passkey" }, 400);
  const { rpID, origin } = rp(c);
  const v = await verifyAuthenticationResponse({ response, expectedChallenge: s.challenge ?? "", expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: key.credential_id, publicKey: Uint8Array.from(atob(key.public_key), (x) => x.charCodeAt(0)), counter: key.counter } }).catch(() => null);
  if (!v?.verified) { await limited(c.env, `admin-fail:${c.req.header("cf-connecting-ip") ?? "local"}`, 5); return c.json({ error: "not_verified" }, 400); }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE admin_passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?").bind(v.authenticationInfo.newCounter, Date.now(), key.credential_id),
    c.env.DB.prepare("UPDATE admin_sessions SET passkey_at = ?, challenge = NULL WHERE token_hash = ?").bind(Date.now(), s.token_hash),
  ]);
  return c.json({ ok: true });
});

admin.get("/api/me", (c) => c.json({ email: c.env.ADMIN_EMAIL, expiresAt: c.get("s").expires_at, passkeyFresh: fresh(c.get("s")) }));
admin.post("/api/signout", async (c) => {
  await c.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(c.get("s").token_hash).run();
  c.header("Set-Cookie", cookieFor("", 0));
  return c.json({ ok: true });
});

// ── Feedback ──
admin.get("/api/feedback", async (c) => {
  const status = c.req.query("status");
  const r = await c.env.DB.prepare(
    `SELECT f.id, f.kind, f.status, f.created_at, f.updated_at, u.name, u.email,
       (SELECT text FROM feedback_messages m WHERE m.feedback_id = f.id ORDER BY created_at LIMIT 1) AS first
     FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${status ? "WHERE f.status = ?" : ""} ORDER BY f.updated_at DESC LIMIT 100`,
  ).bind(...(status ? [status] : [])).all();
  const counts = (await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM feedback GROUP BY status").all<{ status: string; n: number }>()).results;
  return c.json({ items: r.results, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])) });
});

admin.get("/api/feedback/:id", async (c) => {
  const f = await c.env.DB.prepare(
    `SELECT f.*, u.name, u.email, u.created_at AS joined, h.name AS household, m.role,
       (SELECT COUNT(*) FROM members x WHERE x.household_id = f.household_id) AS members
     FROM feedback f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN households h ON h.id = f.household_id LEFT JOIN members m ON m.user_id = f.user_id AND m.household_id = f.household_id WHERE f.id = ?`,
  ).bind(c.req.param("id")).first();
  if (!f) return c.json({ error: "not_found" }, 404);
  const msgs = (await c.env.DB.prepare("SELECT id, author, text, created_at FROM feedback_messages WHERE feedback_id = ? ORDER BY created_at").bind(c.req.param("id")).all()).results;
  return c.json({ ...f, messages: msgs });
});

admin.post("/api/feedback/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ reply?: string; note?: string; status?: string }>();
  const f = await c.env.DB.prepare("SELECT user_id, household_id, status FROM feedback WHERE id = ?").bind(id).first<{ user_id: string | null; household_id: string | null; status: string }>();
  if (!f) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  if (b.reply?.trim()) {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO feedback_messages (id, feedback_id, author, text, created_at) VALUES (?, ?, 'admin', ?, ?)").bind(newId(), id, b.reply.trim().slice(0, 5000), now),
      c.env.DB.prepare("UPDATE feedback SET status = 'replied', user_unread = 1, updated_at = ? WHERE id = ?").bind(now, id),
    ]);
    await audit(c.env, "Replied to feedback", "feedback", id);
    // Tell the person's open devices that a reply is waiting (no content in the signal).
    if (f.user_id && f.household_id) {
      const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(f.household_id));
      c.executionCtx.waitUntil(stub.fetch("https://household/signal", { method: "POST", headers: { "x-haven-signal": "reply", "x-haven-to": f.user_id } }));
    }
  }
  if (b.note != null) await c.env.DB.prepare("UPDATE feedback SET admin_note = ? WHERE id = ?").bind(b.note.slice(0, 2000), id).run();
  if (b.status && ["new", "in_progress", "replied", "done"].includes(b.status) && b.status !== f.status) {
    await c.env.DB.prepare("UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?").bind(b.status, now, id).run();
    await audit(c.env, `Set feedback ${b.status.replace("_", " ")}`, "feedback", id);
  }
  return c.json({ ok: true });
});

// ── Users (account facts and counts only; never household content) ──
admin.get("/api/users", async (c) => {
  const q = `%${(c.req.query("q") ?? "").toLowerCase()}%`;
  const r = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.suspended_at, h.name AS household, m.role,
       (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
     FROM users u LEFT JOIN households h ON h.id = u.household_id LEFT JOIN members m ON m.user_id = u.id
     WHERE lower(u.email) LIKE ? OR lower(u.name) LIKE ? ORDER BY last_seen DESC LIMIT 50`,
  ).bind(q, q).all();
  return c.json({ users: r.results });
});

admin.get("/api/users/:id", async (c) => {
  const id = c.req.param("id");
  const u = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.created_at, u.suspended_at, u.suspended_reason, u.household_id, h.name AS household, h.timezone, h.measurement, h.created_at AS household_created, h.deleted_at, m.role,
       (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS devices
     FROM users u LEFT JOIN households h ON h.id = u.household_id LEFT JOIN members m ON m.user_id = u.id WHERE u.id = ?`,
  ).bind(Date.now(), id).first<{ household_id: string | null }>();
  if (!u) return c.json({ error: "not_found" }, 404);
  const counts = u.household_id ? await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM members WHERE household_id = ?1) AS members, (SELECT COUNT(*) FROM meals_recipes WHERE household_id = ?1 AND deleted = 0) AS recipes,
       (SELECT COUNT(*) FROM meals_trips WHERE household_id = ?1 AND deleted = 0) AS trips`).bind(u.household_id).first() : null;
  const others = u.household_id ? (await c.env.DB.prepare("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? AND m.user_id != ?").bind(u.household_id, id).all()).results : [];
  const feedback = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;
  return c.json({ ...u, counts, others, feedback });
});

admin.post("/api/users/:id/:action", async (c) => {
  const id = c.req.param("id"); const action = c.req.param("action");
  const destructive = ["suspend", "delete", "transfer", "restore"].includes(action);
  if (destructive) { const r = stepUp(c); if (r) return r; }
  const u = await c.env.DB.prepare("SELECT id, email, household_id FROM users WHERE id = ?").bind(id).first<{ id: string; email: string; household_id: string | null }>();
  if (!u) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ reason?: string; to?: string }>().catch(() => ({} as { reason?: string; to?: string }));
  const closeSockets = () => u.household_id && c.executionCtx.waitUntil(c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(u.household_id)).fetch("https://household/signal", { method: "POST", headers: { "x-haven-signal": "close", "x-haven-to": u.id } }));
  switch (action) {
    case "signout": await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run(); closeSockets(); break;
    case "suspend": await c.env.DB.batch([c.env.DB.prepare("UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?").bind(Date.now(), body.reason ?? null, id), c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id)]); closeSockets(); break;
    case "unsuspend": await c.env.DB.prepare("UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?").bind(id).run(); break;
    case "transfer": {
      if (!u.household_id || !body.to) return c.json({ error: "bad_request" }, 400);
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE members SET role = 'member' WHERE household_id = ? AND role = 'owner'").bind(u.household_id),
        c.env.DB.prepare("UPDATE members SET role = 'owner' WHERE household_id = ? AND user_id = ?").bind(u.household_id, body.to),
        c.env.DB.prepare("UPDATE households SET owner_id = ? WHERE id = ?").bind(body.to, u.household_id),
      ]);
      break;
    }
    case "restore": await c.env.DB.prepare("UPDATE households SET deleted_at = NULL WHERE owner_id = ? AND deleted_at > ?").bind(id, Date.now() - 30 * 86_400_000).run(); break;
    case "delete": {
      const n = u.household_id ? (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE household_id = ?").bind(u.household_id).first<{ n: number }>())?.n ?? 0 : 0;
      const stmts: D1PreparedStatement[] = [c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id), c.env.DB.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").bind(id)];
      if (u.household_id && n <= 1) stmts.push(c.env.DB.prepare("UPDATE users SET household_id = NULL WHERE id = ?").bind(id), c.env.DB.prepare("DELETE FROM households WHERE id = ?").bind(u.household_id));
      else if (u.household_id) {
        const next = await c.env.DB.prepare("SELECT user_id FROM members WHERE household_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1").bind(u.household_id, id).first<{ user_id: string }>();
        stmts.push(c.env.DB.prepare("DELETE FROM members WHERE user_id = ?").bind(id));
        if (next) stmts.push(c.env.DB.prepare("UPDATE members SET role = 'owner' WHERE household_id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM members WHERE household_id = ? AND role = 'owner')").bind(u.household_id, next.user_id, u.household_id),
          c.env.DB.prepare("UPDATE households SET owner_id = ? WHERE id = ? AND owner_id = ?").bind(next.user_id, u.household_id, id));
      }
      stmts.push(c.env.DB.prepare("DELETE FROM households WHERE owner_id = ? AND deleted_at IS NOT NULL").bind(id), c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id));
      await c.env.DB.batch(stmts); closeSockets(); break;
    }
    default: return c.json({ error: "unknown_action" }, 400);
  }
  await audit(c.env, { signout: "Signed out everywhere", suspend: "Suspended account", unsuspend: "Lifted suspension", transfer: "Transferred ownership", restore: "Restored household", delete: "Deleted account" }[action]!, "user", u.email);
  return c.json({ ok: true });
});

// Export for a data request: same content as the user's own export.
admin.get("/api/users/:id/export", async (c) => {
  const u = await c.env.DB.prepare("SELECT id, email, name, photo_url, theme, mode, created_at, household_id FROM users WHERE id = ?").bind(c.req.param("id")).first<{ household_id: string | null; email: string }>();
  if (!u) return c.json({ error: "not_found" }, 404);
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), user: u };
  if (u.household_id) for (const t of ["meals_ingredients", "meals_recipes", "meals_planned", "meals_trips", "meals_items"]) out[t] = (await c.env.DB.prepare(`SELECT * FROM ${t} WHERE household_id = ? AND deleted = 0`).bind(u.household_id).all()).results;
  await audit(c.env, "Exported data", "user", u.email);
  c.header("Content-Disposition", `attachment; filename="haven-export-${u.email}.json"`);
  return c.json(out);
});

// ── Health ──
admin.get("/api/health", async (c) => {
  const day = new Date().toISOString().slice(0, 10);
  const usage = (await c.env.DB.prepare("SELECT metric, value, at FROM usage_snapshots WHERE day = ?").bind(day).all<{ metric: keyof typeof LIMITS.daily; value: number; at: number }>()).results;
  const week = Date.now() - 7 * 86_400_000;
  const active = (await c.env.DB.prepare("SELECT COUNT(DISTINCT u.household_id) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.last_seen_at > ? AND u.household_id IS NOT NULL").bind(week).first<{ n: number }>())?.n ?? 0;
  const households = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM households WHERE deleted_at IS NULL").first<{ n: number }>())?.n ?? 0;
  const tripsFinished = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM meals_trips WHERE status = 'finished' AND finished_at > ?").bind(week).first<{ n: number }>())?.n ?? 0;
  const newFeedback = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").first<{ n: number }>())?.n ?? 0;
  return c.json({
    connected: !!(c.env.CF_API_TOKEN && c.env.CF_ACCOUNT_ID),
    usage: usage.map((x) => ({ ...x, limit: LIMITS.daily[x.metric] })),
    metrics: { active, households, tripsFinished, newFeedback },
  });
});

// ── Switches, announcements, audit ──
admin.get("/api/flags", async (c) => c.json({
  flags: (await c.env.DB.prepare("SELECT key, value FROM flags").all<{ key: string; value: string }>()).results.map((f) => ({ key: f.key, value: JSON.parse(f.value) })),
  // Live, scheduled and ended in the last 90 days (older ones are purged nightly).
  announcements: (await c.env.DB.prepare("SELECT a.id, a.kind, a.title, a.text, a.dismissible, a.starts_at, a.ends_at, (SELECT COUNT(*) FROM announcement_dismissals d WHERE d.announcement_id = a.id) AS dismissed FROM announcements a ORDER BY a.starts_at DESC").all()).results,
}));
admin.put("/api/flags/:key", async (c) => {
  const key = c.req.param("key");
  if (!["show_planned_modules", "module_meals_enabled", "offer_install"].includes(key)) return c.json({ error: "unknown_flag" }, 400);
  if (key === "module_meals_enabled") { const r = stepUp(c); if (r) return r; }
  const { value } = await c.req.json<{ value: boolean }>();
  await c.env.DB.prepare("UPDATE flags SET value = ?, updated_at = ? WHERE key = ?").bind(JSON.stringify(!!value), Date.now(), key).run();
  await audit(c.env, value ? "Switched on" : "Switched off", "flag", key);
  return c.json({ ok: true });
});
interface AnnouncementInput { kind: "info" | "warn" | "ok"; title?: string | null; text: string; dismissible: boolean; starts_at: number; ends_at: number }
const valid = (b: AnnouncementInput) => ["info", "warn", "ok"].includes(b.kind) && !!b.text?.trim() && b.ends_at > b.starts_at;
const row = (b: AnnouncementInput) => [b.kind, b.title?.trim().slice(0, 60) || null, b.text.trim().slice(0, 280), b.dismissible ? 1 : 0, b.starts_at, b.ends_at];

/** Tell every open Haven app to fetch announcements again (one signal per household; no content). */
async function announceChanged(env: Env) {
  const homes = (await env.DB.prepare("SELECT id FROM households WHERE deleted_at IS NULL").all<{ id: string }>()).results;
  await Promise.allSettled(homes.map((h) => env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName(h.id)).fetch("https://household/signal", { method: "POST", headers: { "x-haven-signal": "refresh" } })));
}

admin.post("/api/announcements", async (c) => {
  const b = await c.req.json<AnnouncementInput>();
  if (!valid(b)) return c.json({ error: "bad_request" }, 400);
  const id = newId();
  await c.env.DB.prepare("INSERT INTO announcements (kind, title, text, dismissible, starts_at, ends_at, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(...row(b), id, Date.now()).run();
  await audit(c.env, "Scheduled announcement", "announcement", id, { kind: b.kind, title: b.title, text: b.text });
  c.executionCtx.waitUntil(announceChanged(c.env));
  return c.json({ id });
});
admin.put("/api/announcements/:id", async (c) => {
  const b = await c.req.json<AnnouncementInput & { show_again?: boolean }>();
  if (!valid(b)) return c.json({ error: "bad_request" }, 400);
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE announcements SET kind = ?, title = ?, text = ?, dismissible = ?, starts_at = ?, ends_at = ? WHERE id = ?").bind(...row(b), id),
    // "Show it again to people who dismissed it" (decision, Nov 2026): for changes that matter.
    ...(b.show_again ? [c.env.DB.prepare("DELETE FROM announcement_dismissals WHERE announcement_id = ?").bind(id)] : []),
  ]);
  await audit(c.env, b.show_again ? "Edited announcement and showed it again" : "Edited announcement", "announcement", id, { kind: b.kind, title: b.title, text: b.text });
  c.executionCtx.waitUntil(announceChanged(c.env));
  return c.json({ ok: true });
});
admin.delete("/api/announcements/:id", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM announcement_dismissals WHERE announcement_id = ?").bind(c.req.param("id")),
    c.env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(c.req.param("id")),
  ]);
  await audit(c.env, "Removed announcement", "announcement", c.req.param("id"));
  c.executionCtx.waitUntil(announceChanged(c.env));
  return c.json({ ok: true });
});
admin.get("/api/audit", async (c) => c.json({ items: (await c.env.DB.prepare("SELECT at, action, target_type, target_id FROM audit_log ORDER BY at DESC LIMIT 200").all()).results }));

/** Twice-daily usage check (Technical spec › Usage alerts). Best effort: needs CF_API_TOKEN (Account Analytics: Read) and CF_ACCOUNT_ID. */
export async function recordUsage(env: Env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return;
  const day = new Date().toISOString().slice(0, 10);
  const query = `query($acc: String!, $start: Time!, $end: Time!, $date: Date!) { viewer { accounts(filter: { accountTag: $acc }) {
    workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } }
    durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date: $date }) { sum { requests } }
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date: $date }) { sum { rowsRead rowsWritten } } } } }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { acc: env.CF_ACCOUNT_ID, start: `${day}T00:00:00Z`, end: new Date().toISOString(), date: day } }),
  });
  type Sum = { sum: Record<string, number> }[];
  const a = ((await res.json()) as { data?: { viewer: { accounts: Record<string, Sum>[] } } }).data?.viewer.accounts[0];
  if (!a) return;
  const total = (rows: Sum | undefined, k: string) => (rows ?? []).reduce((n, r) => n + (r.sum[k] ?? 0), 0);
  const values = { worker_requests: total(a.workersInvocationsAdaptive, "requests"), do_requests: total(a.durableObjectsInvocationsAdaptiveGroups, "requests"), d1_rows_read: total(a.d1AnalyticsAdaptiveGroups, "rowsRead"), d1_rows_written: total(a.d1AnalyticsAdaptiveGroups, "rowsWritten") };
  await env.DB.batch(Object.entries(values).map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO usage_snapshots (day, metric, value, at) VALUES (?, ?, ?, ?)").bind(day, k, v, Date.now())));
  // Decision (Nov 2026): no email until there's a domain; alerts show in admin Health. When EMAIL is bound, also email here.
}
