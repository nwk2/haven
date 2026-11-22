import { sha256 } from "./crypto";
import type { Env } from "./env";

/**
 * One Durable Object per household (PRD › Technical spec › Sync protocol).
 * Orders every write, stamps the next household version, writes to D1 and
 * broadcasts changed rows. Uses WebSocket hibernation.
 */

// Tables and columns the app may write through sync. Everything else is
// server-only (members, households.owner_id, invites, admin tables...).
const WRITABLE: Record<string, string[]> = {
  activity: ["module_id", "member_id", "text", "at", "deleted"],
  meals_ingredients: ["name", "default_unit", "section", "merged_into", "deleted"],
  meals_recipes: ["title", "base_servings", "ingredients", "steps", "tags", "source", "photo_key", "archived_at", "deleted_at", "deleted"],
  meals_planned: ["date", "slot", "recipe_id", "servings", "status", "bought_on_trip_id", "recipe_snapshot", "deleted"],
  meals_trips: ["date", "kind", "status", "finished_at", "reopen_until", "final_lines", "deleted"],
  meals_items: ["trip_id", "key", "checked", "checked_by", "checked_at", "bought_qty", "bought_unit", "unavailable", "have_it", "carried_from", "label", "qty", "unit", "section", "deleted"],
};
const PULL_TABLES = Object.keys(WRITABLE);
const PAGE = 500;
const PUSH_MAX = 20;

interface Mutation { id: string; table: string; rowId: string; fields: Record<string, unknown> }
interface Attachment { userId: string; householdId: string }

export class Household implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER)");
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)");
  }

  private version(): number {
    const row = this.state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'version'").toArray()[0];
    return row?.v ?? 0;
  }

  async fetch(req: Request): Promise<Response> {
    // Admin signals: "reply waiting" or "close" for one user's open connections. No household content.
    const signal = req.headers.get("x-haven-signal");
    if (signal) {
      const to = req.headers.get("x-haven-to");
      for (const ws of this.state.getWebSockets()) {
        if ((ws.deserializeAttachment() as Attachment).userId !== to) continue;
        if (signal === "close") ws.close(4001, "signed out"); else ws.send(JSON.stringify({ type: "reply" }));
      }
      return new Response(null, { status: 204 });
    }
    const userId = req.headers.get("x-haven-user")!;
    const householdId = req.headers.get("x-haven-household")!;
    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ userId, householdId } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // HTTPS fallback (/api/sync): same messages, one round trip.
    const msg = (await req.json()) as ClientMessage;
    try { return Response.json(await this.handle(msg, { userId, householdId }, null)); }
    catch (e) { console.error("sync: request failed", String(e)); return Response.json({ type: "error", message: "server_error" } satisfies ServerMessage, { status: 500 }); }
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const who = ws.deserializeAttachment() as Attachment;
    // Never fail silently: a thrown error becomes an explicit reply, so the phone shows "Can't sync" and retries.
    try {
      const reply = await this.handle(JSON.parse(String(data)), who, ws);
      if (reply) ws.send(JSON.stringify(reply));
    } catch (e) {
      console.error("sync: message failed", String(e));
      ws.send(JSON.stringify({ type: "error", message: "server_error" } satisfies ServerMessage));
    }
  }

  async webSocketClose(ws: WebSocket) { ws.close(); }

  private async handle(msg: ClientMessage, who: Attachment, from: WebSocket | null): Promise<ServerMessage | null> {
    // Versioning: accept the current protocol and the one before it.
    const current = Number(this.env.PROTOCOL_VERSION);
    if (msg.protocol < current - 1) return { type: "too_old", minProtocol: current - 1 };

    if (msg.type === "pull") return this.pull(who.householdId, msg.since);
    if (msg.type === "presence") {
      // Ephemeral "Jon is editing" (PRD › Recipe editor rules): relayed, never stored.
      const out = JSON.stringify({ type: "presence", userId: who.userId, name: String(msg.name ?? "").slice(0, 40), recipeId: msg.recipeId ?? null, at: Date.now() });
      for (const ws of this.state.getWebSockets()) if (ws !== from) ws.send(out);
      return null;                                           // no reply: presence isn't part of the push/ack cycle
    }

    // push. The admin's module off switch refuses module writes (data is kept).
    const mealsOn = (await this.env.DB.prepare("SELECT value FROM flags WHERE key = 'module_meals_enabled'").first<{ value: string }>())?.value !== "false";
    if (!mealsOn) msg = { ...msg, mutations: msg.mutations.filter((m) => !m.table.startsWith("meals_")) };
    const acked: string[] = [];
    const rejected: string[] = [];
    const changed: Record<string, unknown>[] = [];
    let v = this.version();
    const OWNER_ONLY = new Set(["merged_into"]);
    let role: string | null = null;
    // Free plan: at most 50 D1 queries per request. Each change costs 2 (update + insert-if-missing),
    // so take at most 20 per push; the rest stay in the client's outbox for the next push.
    for (const m of msg.mutations.slice(0, PUSH_MAX)) {
      if (this.state.storage.sql.exec("SELECT 1 FROM seen WHERE id = ?", m.id).toArray().length) { acked.push(m.id); continue; }
      const cols = WRITABLE[m.table];
      if (!cols) { rejected.push(m.id); continue; }
      if (Object.keys(m.fields).some((k) => OWNER_ONLY.has(k))) {
        role ??= (await this.env.DB.prepare("SELECT role FROM members WHERE household_id = ? AND user_id = ?").bind(who.householdId, who.userId).first<{ role: string }>())?.role ?? "none";
        if (role !== "owner") { rejected.push(m.id); continue; }
      }
      const fields = Object.entries(m.fields).filter(([k]) => cols.includes(k) && k !== "deleted_at");
      // deleted_at is the server's clock, never the client's (it decides when tombstones are purged).
      if ("deleted" in m.fields) fields.push(["deleted_at", m.fields.deleted ? Date.now() : null]);
      if (!fields.length) { rejected.push(m.id); continue; }
      const nextV = v + 1;
      const names = fields.map(([k]) => k);
      const vals = fields.map(([, x]) => x);
      const isItem = m.table === "meals_items";
      // Key: (trip_id, key) for items, id otherwise. household_id always comes from the session.
      const keyWhere = isItem ? "trip_id = ? AND key = ?" : "id = ?";
      const keyVals = isItem ? [String(m.fields.trip_id ?? ""), String(m.fields.key ?? "")] : [m.rowId];
      // Update the existing row (only this household's), or insert it if it doesn't exist yet.
      // A plain INSERT … ON CONFLICT can't be used: SQLite checks NOT NULL on the insert before
      // seeing the conflict, so partial updates (finish a trip, delete a meal) would be rejected.
      const update = this.env.DB.prepare(`UPDATE ${m.table} SET ${names.map((n) => `${n} = ?`).join(", ")}, version = ? WHERE ${keyWhere} AND household_id = ?`)
        .bind(...vals, nextV, ...keyVals, who.householdId);
      const insertCols = isItem ? ["household_id", ...names, "version"] : ["id", "household_id", ...names, "version"];
      const insertVals = isItem ? [who.householdId, ...vals, nextV] : [m.rowId, who.householdId, ...vals, nextV];
      const insert = this.env.DB.prepare(`INSERT INTO ${m.table} (${insertCols.join(", ")}) SELECT ${insertCols.map(() => "?").join(", ")} WHERE NOT EXISTS (SELECT 1 FROM ${m.table} WHERE ${keyWhere})`)
        .bind(...insertVals, ...keyVals);
      try {
        // One change per batch: a bad change is rejected on its own and never blocks the others.
        const [u, i] = await this.env.DB.batch([update, insert]);
        if (!u.meta.changes && !i.meta.changes) { rejected.push(m.id); continue; }   // row belongs to another household
      } catch (e) {
        console.error("sync: rejected mutation", m.table, m.id, String(e));
        rejected.push(m.id);
        continue;
      }
      v = nextV;
      this.state.storage.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('version', ?)", v);
      this.state.storage.sql.exec("INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)", m.id, Date.now());
      changed.push({ table: m.table, rowId: m.rowId, ...Object.fromEntries(fields), version: v });
      acked.push(m.id);
      // Success-metric events (Technical spec › Measuring success): no names or emails, household id hashed.
      const ev = m.table === "meals_trips" && m.fields.status === "finished" ? "trip_finished"
        : m.table === "meals_trips" && m.fields.kind === "regular" && m.fields.date ? "list_generated"
        : m.table === "meals_items" && String(m.fields.key ?? "").startsWith("extra_") && m.fields.label ? "list_item_edited" : null;
      if (ev) this.env.EVENTS?.writeDataPoint({ blobs: [ev], indexes: [await sha256(who.householdId)] });
    }
    for (const id of rejected) this.state.storage.sql.exec("INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)", id, Date.now());
    this.state.storage.sql.exec("DELETE FROM seen WHERE id NOT IN (SELECT id FROM seen ORDER BY at DESC LIMIT 1000)");
    if (changed.length) {
      const out = JSON.stringify({ type: "changes", rows: changed, version: v } satisfies ServerMessage);
      for (const ws of this.state.getWebSockets()) if (ws !== from) ws.send(out);
    }
    // Rejected changes are acknowledged too, so they leave the outbox instead of blocking it forever.
    return { type: "ack", ids: [...acked, ...rejected], rejected, version: v };
  }

  private async pull(householdId: string, since: number): Promise<ServerMessage> {
    // Rows up to purge_floor may have been purged; a device behind it can't learn about those deletions.
    if (since > 0) {
      const floor = (await this.env.DB.prepare("SELECT purge_floor FROM households WHERE id = ?").bind(householdId).first<{ purge_floor: number }>())?.purge_floor ?? 0;
      if (since < floor) return { type: "resync" };
    }
    const rows: Record<string, unknown>[] = [];
    for (const table of PULL_TABLES) {
      const res = await this.env.DB.prepare(`SELECT * FROM ${table} WHERE household_id = ? AND version > ? ORDER BY version LIMIT ?`)
        .bind(householdId, since, PAGE).all();
      for (const r of res.results) rows.push({ table, ...r });
    }
    rows.sort((a, b) => (a.version as number) - (b.version as number));
    const page = rows.slice(0, PAGE);
    const last = page.length ? (page[page.length - 1].version as number) : since;
    return { type: "changes", rows: page, version: last, more: rows.length > PAGE };
  }
}

export type ClientMessage =
  | { type: "pull"; protocol: number; since: number }
  | { type: "presence"; protocol: number; recipeId: string | null; name: string }
  | { type: "push"; protocol: number; mutations: Mutation[] };

export type ServerMessage =
  | { type: "changes"; rows: Record<string, unknown>[]; version: number; more?: boolean }
  | { type: "ack"; ids: string[]; rejected?: string[]; version: number }
  | { type: "too_old"; minProtocol: number }
  | { type: "resync" }
  | { type: "error"; message: string }
  | { type: "presence"; userId: string; name: string; recipeId: string | null; at: number };
