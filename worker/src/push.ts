/**
 * Web Push (RFC 8291 message encryption, aes128gcm; RFC 8292 VAPID) with Web Crypto only, so it runs in
 * Workers. No imports, so worker/test/push.test.mjs can run it under Node and decrypt what it produces.
 */
export interface PushSub { endpoint: string; p256dh: string; auth: string }
export interface Vapid { publicKey: string; privateKey: string; subject: string }

const te = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** Encrypts `payload` for one subscription (RFC 8291). Returns the request body. */
export async function encrypt(sub: PushSub, payload: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Standard Web Crypto field name ("public"); Cloudflare's type definitions call it "$public".
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0], as.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(te.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** "vapid t=<jwt>, k=<public key>" for one push service origin (RFC 8292), valid 12 hours. */
export async function vapidAuth(endpoint: string, v: Vapid, now = Date.now()): Promise<string> {
  const pub = fromB64u(v.publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: v.privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

/** Sends one notification. "gone" means the subscription expired and should be deleted. */
export async function sendPush(sub: PushSub, message: object, v: Vapid, urgency: "normal" | "high" = "normal"): Promise<"ok" | "gone" | "error"> {
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "21600", Urgency: urgency, Authorization: await vapidAuth(sub.endpoint, v) },
      body: await encrypt(sub, te.encode(JSON.stringify(message))),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch { return "error"; }
}
