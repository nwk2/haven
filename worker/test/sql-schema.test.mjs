// Every SQL statement in the Worker, and every sync-writable column, must match the real migrations.
// Run: node --no-warnings test/sql-schema.test.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
const db = new DatabaseSync(":memory:");
for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
let n = 0, bad = 0;
for (const file of readdirSync("src", { recursive: true }).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(`src/${file}`, "utf8");
  const re = /prepare\(\s*(`[\s\S]*?`|"(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(src))) {
    // A variable-length IN list ("IN (${marks})") is checked as one placeholder.
    let sql = m[1].slice(1, -1).replace(/IN \(\$\{[^}]*\}\)/g, "IN (?)");
    // Expand interpolations: table loops and optional WHERE fragments.
    const variants = [];
    if (sql.includes("${table}") || sql.includes("${t}")) for (const t of ["activity", "meals_ingredients", "meals_recipes", "meals_planned", "meals_list_states", "todos_lists", "todos_items", "todos_mutes"]) variants.push(sql.replaceAll("${table}", t).replaceAll("${t}", t));
    else if (sql.includes("${Object.keys(WRITABLE)")) {
      // Version reconcile: one MAX(version) per sync table, unioned (household.ts).
      const tables = ["activity", "meals_ingredients", "meals_recipes", "meals_planned", "meals_list_states", "todos_lists", "todos_items", "todos_mutes"];
      variants.push(`SELECT MAX(${tables.map((t) => `COALESCE((SELECT MAX(version) FROM ${t} WHERE household_id = ?1), 0)`).join(", ")}) AS v`);
    }
    else if (sql.includes("${m.table}")) continue;                       // generic upsert, columns from the WRITABLE allow-list (checked below)
    else variants.push(sql.replace(/\$\{status \? "WHERE f.status = \?" : ""\}/, "WHERE f.status = ?").replace(/\$\{sets\.join\(", "\)\}/, "name = ?"));
    for (const v of variants) {
      n++;
      try { db.prepare(v.replace(/\?\d*/g, "NULL")); }
      catch (e) { bad++; console.log(`${file}: ${e.message}\n   ${v.replace(/\s+/g, " ").slice(0, 140)}`); }
    }
  }
}
// The sync allow-list: every writable column must exist.
const hh = readFileSync("src/household.ts", "utf8");
const writable = eval("(" + hh.match(/const WRITABLE: Record<string, string\[\]> = (\{[\s\S]*?\n\});/)[1] + ")");
for (const [t, cols] of Object.entries(writable)) {
  const have = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of cols) { n++; if (!have.includes(c)) { bad++; console.log(`household.ts WRITABLE: ${t}.${c} does not exist`); } }
}
console.log(`sql-schema: checked ${n} statements/columns, ${bad} problems`);
if (bad) process.exit(1);
