// Creates the VAPID key pair Haven signs push notifications with (RFC 8292). Run once: npm run vapid
// The public key goes in wrangler.toml [vars]; the private key is a secret on the "haven" Worker.
import crypto from "node:crypto";
const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
console.log(`
VAPID keys for Haven push notifications

1. In wrangler.toml, under [vars] (public by design; commit it):
   VAPID_PUBLIC_KEY = "${pub}"

2. As a RUNTIME secret on the "haven" Worker: Cloudflare dashboard › Workers & Pages › haven ›
   Settings › Variables and secrets › Add, type Secret. Not "Secrets used during build": those
   are invisible to the running Worker, and notifications would silently never send.
   Or: npx wrangler secret put VAPID_PRIVATE_KEY
   VAPID_PRIVATE_KEY = ${jwk.d}

The subject (who runs this server) defaults to https://haven.wk-io.workers.dev. If Haven moves to
your own domain, add VAPID_SUBJECT = "https://your.domain" under [vars] too.

Keep the private key secret. If you ever replace the keys, every device has to turn notifications on again.
`);
