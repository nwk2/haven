import { randomToken, sha256 } from "../crypto";
import type { Env } from "../env";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export interface GoogleProfile { sub: string; email: string; name: string; picture?: string }

/** Step 1: state + PKCE, redirect to Google (scopes: openid email profile only).
 *  Google sends people back to "/" (the redirect URIs registered for the MVP); the Worker routes that to the callback. */
export async function startGoogle(env: Env, origin: string) {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = await sha256(verifier);
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), state, verifier };
}

/** Step 2: exchange the code and verify the ID token. */
export async function finishGoogle(env: Env, origin: string, code: string, verifier: string): Promise<GoogleProfile> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, code_verifier: verifier, grant_type: "authorization_code",
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const { id_token } = (await res.json()) as { id_token: string };
  const claims = await verifyIdToken(id_token, env.GOOGLE_CLIENT_ID);
  if (!claims.email_verified) throw new Error("email not verified");
  return { sub: claims.sub, email: claims.email, name: claims.name ?? claims.email, picture: claims.picture };
}

let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;

async function verifyIdToken(token: string, audience: string) {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")));
  const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  if (!jwksCache || Date.now() - jwksCache.at > 3_600_000) {
    jwksCache = { keys: ((await (await fetch(JWKS)).json()) as { keys: JsonWebKey[] }).keys, at: Date.now() };
  }
  const jwk = jwksCache.keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${h}.${p}`));
  const now = Math.floor(Date.now() / 1000);
  if (!ok) throw new Error("bad signature");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("bad issuer");
  if (claims.aud !== audience) throw new Error("bad audience");
  if (claims.exp < now) throw new Error("expired");
  return claims as { sub: string; email: string; email_verified: boolean; name?: string; picture?: string };
}
