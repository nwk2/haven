import { randomToken, sha256 } from "../crypto";
import type { Env } from "../env";

export const SESSION_COOKIE = "__Host-haven_session";
const DAYS_90 = 90 * 86_400_000;

export async function createSession(env: Env, userId: string, device: string) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, device) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(await sha256(token), userId, now, now, now + DAYS_90, device.slice(0, 120)).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS_90 / 1000}`;
}

export interface SessionUser { id: string; email: string; name: string; household_id: string | null; suspended_at: number | null }

/** Returns the signed-in user, renewing the session's 90-day window. */
export async function readSession(env: Env, cookieHeader: string | null): Promise<SessionUser | null> {
  const token = cookieHeader?.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split("=")[1];
  if (!token) return null;
  const hash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.household_id, u.suspended_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(hash, now).first<SessionUser>();
  if (!row || row.suspended_at) return null;
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
    .bind(now, now + DAYS_90, hash).run();
  return row;
}

export const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
