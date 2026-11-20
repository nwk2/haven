// Haven shell auth — Batch 2. Google-only sign-in (auth-code flow),
// 90-day sliding sessions, household roster + invite links. No
// email/password, no passwords stored, no reset flow. Only session token
// hashes are stored (spec §8; Don't Ngiao precedent).
//
// The Google client ID is public by design (it is in the frontend auth
// URL); only the secret is sensitive, and it lives only as the
// GOOGLE_CLIENT_SECRET Worker secret, set in the Cloudflare dashboard.
// The API path for setting secrets was attempted and is blocked by the
// Worker-versions rule (error 10215), and the secret value was never
// shared with the agent — so the dashboard is the way it gets set.

export const GOOGLE_CLIENT_ID =
  "710021216622-hp6scvlvmm2q05adlrd5sijm2qltsanh.apps.googleusercontent.com";

// Redirect URIs registered in Google Cloud Console. The frontend sends the
// one matching its own origin; the Worker only accepts these exact values,
// so a code can never be exchanged against an attacker's redirect URI.
export const GOOGLE_REDIRECT_URIS = [
  "https://haven.wk-io.workers.dev/",
  "http://localhost:8787/",
] as const;

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, sliding
export const SESSION_TOUCH_MS = 60 * 60 * 1000; // at most one sliding write per hour

export interface AuthEnv {
  DB: D1Database;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export interface HouseholdRef {
  id: string;
  name: string;
  role: string;
  creator_id: string;
}

export interface AuthContext {
  user: SessionUser;
  household: HouseholdRef | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Random ids and tokens: 32 bytes, base64url. The session token itself is
// never stored — only its SHA-256 hash (sessions.id).
export function uid(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Google sign-in, Nov 2026 (Don't Ngiao precedent): authorization-code
// flow. The Worker exchanges the code for tokens, then calls Google's
// userinfo endpoint with the access token — Google validates the token, so
// no JWT verification is needed in the Worker. Returns the verified
// { sub, email, email_verified, name } or throws.
export async function googleUserFromCode(
  env: AuthEnv,
  code: string,
  redirectUri: string,
): Promise<{ sub: string; email: string; email_verified: boolean; name: string }> {
  if (!env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google sign-in is not configured, try again later");
  }
  let tokRes: Response;
  try {
    tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    throw new Error("Could not reach Google, try again");
  }
  const tokData: any = await tokRes.json().catch(() => ({}));
  const accessToken = tokData?.access_token;
  if (!tokRes.ok || !accessToken) throw new Error("Google sign-in failed, try again");
  let infoRes: Response;
  try {
    infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Could not reach Google, try again");
  }
  const info: any = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info?.sub || !info?.email) {
    throw new Error("Google sign-in failed, try again");
  }
  return {
    sub: String(info.sub),
    email: String(info.email),
    email_verified: info.email_verified === true,
    name: String(info.name || ""),
  };
}

export function bearerToken(req: Request): string | null {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return tok || null;
}

// Validate a session token: hash it, look it up, enforce expiry, slide the
// window. Returns null for a missing, unknown or expired session. An
// expired session row is deleted so the token cannot be reused.
export async function authSession(req: Request, env: AuthEnv): Promise<AuthContext | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const hash = await sha256Hex(token);
  // The session lookup and the household lookup are one D1 round-trip:
  // the household statement resolves its user through the session row
  // itself (subquery on the token hash), so both statements are
  // independent and batchable. The household result is only used when
  // the session row exists and is unexpired, so a household row for a
  // dead session can never leak through.
  const [sessionRes, householdRes] = await env.DB.batch([
    env.DB.prepare(
      "SELECT s.expires_at AS expires_at, s.last_seen_at AS last_seen_at, " +
        "u.id AS id, u.name AS name, u.email AS email, u.created_at AS created_at " +
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
    ).bind(hash),
    env.DB.prepare(
      HOUSEHOLD_SELECT + "WHERE m.user_id = (SELECT user_id FROM sessions WHERE id = ?)",
    ).bind(hash),
  ]);
  const row: any = sessionRes.results[0];
  if (!row) return null;
  if (Date.parse(String(row.expires_at)) <= Date.now()) {
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(hash).run();
    } catch {}
    return null;
  }
  // Sliding window (spec §8: expiry extends on each use): refresh
  // last_seen_at and expires_at, but at most once an hour, so an active
  // session does not cost a D1 write on every request (Don't Ngiao
  // precedent). The observable behaviour is the same: expiry is always
  // 90 days after the last recorded use.
  const lastMs = Date.parse(String(row.last_seen_at));
  if (Number.isFinite(lastMs) && Date.now() - lastMs > SESSION_TOUCH_MS) {
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    try {
      await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
        .bind(now.toISOString(), expires, hash)
        .run();
    } catch {}
  }
  const user: SessionUser = {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    created_at: String(row.created_at),
  };
  const household = toHouseholdRef(householdRes.results[0]);
  return { user, household };
}

// The household roster lookup, shared by householdFor (by user id) and
// authSession (by session hash, via subquery) so the column list has one
// source of truth.
const HOUSEHOLD_SELECT =
  "SELECT h.id AS id, h.name AS name, h.creator_id AS creator_id, m.role AS role " +
  "FROM household_members m JOIN households h ON h.id = m.household_id ";

function toHouseholdRef(m: any): HouseholdRef | null {
  if (!m) return null;
  return {
    id: String(m.id),
    name: String(m.name),
    role: String(m.role),
    creator_id: String(m.creator_id),
  };
}

export async function householdFor(env: AuthEnv, userId: string): Promise<HouseholdRef | null> {
  const m: any = await env.DB.prepare(HOUSEHOLD_SELECT + "WHERE m.user_id = ?")
    .bind(userId)
    .first();
  return toHouseholdRef(m);
}

export async function issueSession(
  env: AuthEnv,
  userId: string,
): Promise<{ token: string; expires_at: string }> {
  const token = uid();
  const hash = await sha256Hex(token);
  const now = new Date();
  const expires_at = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(hash, userId, now.toISOString(), expires_at, now.toISOString())
    .run();
  return { token, expires_at };
}

export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/?invite=${token}`;
}
