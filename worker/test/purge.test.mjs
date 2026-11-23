// Runs the nightly purge against the real migrations in SQLite (node:sqlite).
// Run: node --experimental-strip-types worker/test/purge.test.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { purge } from "../src/purge.ts";

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON;");
for (const f of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));

// Minimal D1 shim: prepare/bind/batch, batch is one transaction like D1.
const D1 = {
  prepare: (sql) => ({ sql, args: [], bind(...a) { return { sql, args: a }; } }),
  async batch(stmts) {
    db.exec("BEGIN");
    try { for (const s of stmts) db.prepare(s.sql).run(...s.args); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  },
};

const now = Date.UTC(2026, 11, 1);
const day = 86_400_000;
db.exec(`
  INSERT INTO users (id, google_sub, email, name, created_at) VALUES ('u1','g1','a@x','A',0), ('u2','g2','b@x','B',0);
  INSERT INTO households (id, name, owner_id, timezone, created_at, invite_code, invite_expires_at, deleted_at) VALUES
    ('keep','Keep','u1','UTC',0,'fresh', ${now + day}, NULL),
    ('expinv','Expired invite','u1','UTC',0,'old', ${now - day}, NULL),
    ('gone','Deleted 40 days ago','u2','UTC',0,NULL,NULL, ${now - 40 * day}),
    ('restorable','Deleted 10 days ago','u2','UTC',0,NULL,NULL, ${now - 10 * day});
  INSERT INTO sessions VALUES ('s-old','u1',0,0,${now - 1},'x'), ('s-live','u1',0,0,${now + day},'x');
  INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES ('a-old',0,${now - 1}), ('a-live',0,${now + day});
  INSERT INTO activity (id, household_id, module_id, text, at, version) VALUES ('act-old','keep','meals','x',${now - 91 * day},1), ('act-new','keep','meals','x',${now - day},2);
  INSERT INTO meals_recipes (id, household_id, title, base_servings, version, deleted, deleted_at) VALUES
    ('r-old','keep','Old',2,1,1,${now - 31 * day}), ('r-recent','keep','Recent',2,2,1,${now - day}), ('r-live','keep','Live',2,3,0,NULL);
  INSERT INTO meals_recipes (id, household_id, title, base_servings, version) VALUES ('r-in-gone','gone','Cascades',2,4);
  INSERT INTO feedback (id, kind, created_at, updated_at) VALUES ('f-old','idea',0,${now - 366 * day}), ('f-new','idea',0,${now - day});
  INSERT INTO audit_log (id, at, action, target_type) VALUES ('l-old',${now - 366 * day},'x','y'), ('l-new',${now - day},'x','y');
  INSERT INTO announcements (id, text, starts_at, ends_at, kind) VALUES ('a-old','x',${now - 120 * day},${now - 91 * day},'info'), ('a-new','x',${now - 10 * day},${now - 5 * day},'warn');
  INSERT INTO announcement_dismissals (user_id, announcement_id, at) VALUES ('u1','a-old',0), ('u1','a-new',0);
  INSERT INTO meals_trips (id, household_id, date, version, deleted, deleted_at) VALUES ('t-live','keep','2026-12-01',10,0,NULL), ('t-old','keep','2026-10-01',11,1,${now - 31 * day}), ('t-recent','keep','2026-11-01',12,1,${now - day});
  INSERT INTO meals_items (household_id, trip_id, key, version, deleted, deleted_at) VALUES ('keep','t-live','feta_mass',13,1,${now - 40 * day}), ('keep','t-live','beans_count-can',14,0,NULL);
  INSERT INTO meals_planned (id, household_id, date, slot, recipe_id, servings, version, deleted, deleted_at) VALUES ('p-old','expinv','2026-10-01','dinner','r-live',2,7,1,${now - 35 * day});
`);

await purge({ DB: D1 }, now);

const ids = (sql) => db.prepare(sql).all().map((r) => Object.values(r)[0]).sort();
assert.deepEqual(ids("SELECT token_hash FROM sessions"), ["s-live"]);
assert.deepEqual(ids("SELECT token_hash FROM admin_sessions"), ["a-live"]);
assert.deepEqual(ids("SELECT id FROM activity"), ["act-new"]);
assert.deepEqual(ids("SELECT id FROM feedback"), ["f-new"]);
assert.deepEqual(ids("SELECT id FROM audit_log"), ["l-new"]);
assert.deepEqual(ids("SELECT id FROM announcements"), ["a-new"]);
assert.deepEqual(ids("SELECT announcement_id AS id FROM announcement_dismissals"), ["a-new"]);
assert.deepEqual(ids("SELECT id FROM households"), ["expinv", "keep", "restorable"]);
assert.equal(db.prepare("SELECT invite_code FROM households WHERE id = 'expinv'").get().invite_code, null);
assert.equal(db.prepare("SELECT invite_code FROM households WHERE id = 'keep'").get().invite_code, "fresh");
assert.deepEqual(ids("SELECT id FROM meals_recipes"), ["r-live", "r-recent"]);   // r-in-gone cascaded with its household
assert.deepEqual(ids("SELECT id FROM meals_trips"), ["t-live", "t-recent"]);
assert.deepEqual(ids("SELECT key FROM meals_items"), ["beans_count-can"]);
assert.deepEqual(ids("SELECT id FROM meals_planned"), []);
// purge_floor = highest purged version per household (keep: recipe r-old v1, trip v11, item v13 → 13; expinv: v7; untouched: 0)
assert.equal(db.prepare("SELECT purge_floor FROM households WHERE id = 'keep'").get().purge_floor, 13);
assert.equal(db.prepare("SELECT purge_floor FROM households WHERE id = 'expinv'").get().purge_floor, 7);
assert.equal(db.prepare("SELECT purge_floor FROM households WHERE id = 'restorable'").get().purge_floor, 0);
console.log("purge: all 15 checks passed");
