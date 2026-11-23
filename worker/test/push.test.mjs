// Web Push: decrypt what src/push.ts encrypts (RFC 8291) and verify its VAPID signature (RFC 8292),
// using Node's own crypto as the independent implementation. Run: node --experimental-strip-types test/push.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { encrypt, vapidAuth } from "../src/push.ts";

const b64u = (b) => Buffer.from(b).toString("base64url");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();

// A browser's subscription keys.
const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) };

let checks = 0;
for (const text of ["{\"title\":\"Call the plumber\"}", "x".repeat(2000), JSON.stringify({ title: "3 to-dos today", body: "Ünïcödé · 🧹" })]) {
  const body = Buffer.from(await encrypt(sub, new TextEncoder().encode(text)));
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "last-record delimiter");
  assert.equal(plain.subarray(0, -1).toString(), text); checks++;
}

// VAPID: generate keys the way scripts/vapid-keys.mjs does, then verify the JWT with Node.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const vapid = { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])), privateKey: jwk.d, subject: "mailto:you@example.com" };
const header = await vapidAuth(sub.endpoint, vapid, Date.parse("2026-11-23T10:00:00Z"));
const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
assert.equal(k, vapid.publicKey);
const [h, c, s] = jwt.split(".");
const claims = JSON.parse(Buffer.from(c, "base64url").toString());
assert.equal(claims.aud, "https://fcm.googleapis.com"); assert.equal(claims.sub, vapid.subject);
assert.equal(claims.exp, Date.parse("2026-11-23T22:00:00Z") / 1000);
assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), "VAPID signature verifies");
checks += 5;
console.log(`push: ${checks} checks passed (3 payloads decrypted, VAPID signature verified)`);
