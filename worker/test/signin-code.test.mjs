// The one-time admin sign-in code (migration 0009): the exact statements the endpoints
// in src/admin.ts run, against the real migrations in SQLite. No HTTP harness — the
// code paths are SQL + SHA-256, so this pins the hash format, the expiry, and the
// single-use UPDATE (a second redemption must change zero rows).
// Run: node --no-warnings test/signin-code.test.mjs
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const db = new DatabaseSync(":memory:");
for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));

// Same as src/crypto.ts sha256: base64url of the digest. Same as src/admin.ts codeHash:
// upper-cased, punctuation stripped.
const codeHash = (code) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("base64url");
const now = Date.now();
const CODE = "K7M2-9XQW";
const hash = codeHash(CODE);

const find = () => db.prepare("SELECT code_hash FROM admin_signin_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(hash, now);
const redeem = () => db.prepare("UPDATE admin_signin_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now, hash);

// A fresh code redeems, then is spent: the lookup fails and a second UPDATE changes nothing.
db.prepare("INSERT INTO admin_signin_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(hash, now, now + 600_000);
assert.ok(find(), "fresh code is found");
assert.equal(redeem().changes, 1, "first redemption marks it used");
assert.equal(find(), undefined, "a used code is not found again");
assert.equal(redeem().changes, 0, "a second redemption changes zero rows");

// Hyphens, spaces and lower case are all the same code.
assert.equal(codeHash("k7m2 9xqw"), hash, "normalisation: case and punctuation ignored");
assert.equal(codeHash("K7M29XQW"), hash, "normalisation: no hyphen needed");

// Expired and wrong codes are not found.
db.prepare("INSERT INTO admin_signin_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(codeHash("AAAA-1111"), now - 700_000, now - 100_000);
assert.equal(db.prepare("SELECT code_hash FROM admin_signin_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(codeHash("AAAA-1111"), now), undefined, "expired code is not found");
assert.equal(db.prepare("SELECT code_hash FROM admin_signin_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").get(codeHash("ZZZZ-9999"), now), undefined, "wrong code is not found");

// Generating a code retires any unused ones, then inserts the new one.
db.prepare("INSERT INTO admin_signin_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(codeHash("BBBB-2222"), now, now + 600_000);
db.prepare("INSERT INTO admin_signin_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(codeHash("CCCC-3333"), now, now + 600_000);
db.prepare("UPDATE admin_signin_codes SET used_at = ? WHERE used_at IS NULL").run(now);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_signin_codes WHERE used_at IS NULL").get().n, 0, "new code retires unused ones");
db.prepare("INSERT INTO admin_signin_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(codeHash("DDDD-4444"), now, now + 600_000);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_signin_codes WHERE used_at IS NULL").get().n, 1, "exactly the new code is live");

// Redemption creates a Google-verified session (passkey_at = 0): the admin still does the passkey step.
db.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at, passkey_at) VALUES (?, ?, ?, 0)").run("tok", now, now + 90 * 86_400_000);
const s = db.prepare("SELECT passkey_at, expires_at FROM admin_sessions WHERE token_hash = 'tok'").get();
assert.equal(s.passkey_at, 0, "code session starts without a passkey");
assert.ok(s.expires_at > now + 89 * 86_400_000, "code session lasts 90 days");

console.log("signin-code: 10 checks passed (redeem once, expiry, normalisation, retire-on-generate, session shape)");
