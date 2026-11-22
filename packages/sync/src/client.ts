import { HavenDB, JSON_COLS, itemId, type OutboxEntry, type Row, type TableName } from "./db";

export type SyncState = "connecting" | "offline" | "syncing" | "synced" | "error" | "too_old";
export interface SyncStatus { state: SyncState; pending: number }

type ServerMessage =
  | { type: "changes"; rows: Record<string, unknown>[]; version: number; more?: boolean }
  | { type: "ack"; ids: string[]; rejected?: string[]; version: number }
  | { type: "too_old"; minProtocol: number }
  | { type: "resync" }
  | { type: "error"; message?: string }
  | { type: "presence"; userId: string; name: string; recipeId: string | null; at: number };

export interface Presence { userId: string; name: string; recipeId: string | null; at: number }

const PUSH_MAX = 20; // matches the server's per-push limit (2 D1 queries per change, 50 per request)

/**
 * Sync client (Technical spec › Sync protocol): connect, pull since cursor,
 * push the outbox in order, apply live changes from others. Every write goes
 * to IndexedDB first; screens read only from IndexedDB.
 */
export class Sync {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** A pull or push with no answer within this time counts as a failed sync (Technical spec › Sync protocol). */
  static REPLY_TIMEOUT_MS = 15_000;
  private stopped = false;
  status: SyncStatus = { state: "connecting", pending: 0 };
  private listeners = new Set<(s: SyncStatus) => void>();
  private presenceListeners = new Set<(p: Presence) => void>();
  onPresence(fn: (p: Presence) => void) { this.presenceListeners.add(fn); return () => this.presenceListeners.delete(fn); }
  /** Tell others which recipe you're editing (null when you leave). */
  presence(recipeId: string | null, name: string) { if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "presence", recipeId, name }); }

  constructor(readonly db: HavenDB, private protocol: number, private onReplySignal?: () => void) {}

  subscribe(fn: (s: SyncStatus) => void) { this.listeners.add(fn); fn(this.status); return () => this.listeners.delete(fn); }

  private async setStatus(state?: SyncState) {
    const pending = await this.db.outbox.count();
    this.status = { state: state ?? this.status.state, pending };
    this.listeners.forEach((fn) => fn(this.status));
  }

  start() {
    this.stopped = false;
    addEventListener("online", this.reconnect);
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  stop() {
    this.stopped = true;
    removeEventListener("online", this.reconnect);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.timer) clearTimeout(this.timer);
    this.disarm();
    this.ws?.close();
  }

  private onVisible = () => { if (document.visibilityState === "visible" && !this.ws) this.reconnect(); };
  private reconnect = () => { this.retry = 0; this.connect(); };

  private connect() {
    if (this.stopped || this.status.state === "too_old" || this.ws) return;
    if (!navigator.onLine) { void this.setStatus("offline"); return; }
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = async () => { this.retry = 0; await this.setStatus("syncing"); this.send({ type: "pull", since: await this.cursor() }); };
    ws.onmessage = (e) => { this.disarm(); void this.receive(JSON.parse(String(e.data)) as ServerMessage | { type: "reply" }); };
    ws.onclose = (e) => {
      this.disarm();
      if (e.code === 4001) { this.stopped = true; this.ws = null; this.onReplySignal?.(); return; }   // signed out by the server (suspended, removed)
      this.ws = null;
      this.pushing = false;
      if (this.stopped || this.status.state === "too_old") return;
      void this.setStatus(navigator.onLine ? "error" : "offline");
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: { type: string; [k: string]: unknown }) {
    this.ws?.send(JSON.stringify({ protocol: this.protocol, ...msg }));
    if (msg.type === "pull" || msg.type === "push") this.arm();
  }

  /** No answer in time: say so and reconnect, instead of showing "Syncing…" forever. */
  private arm() {
    this.disarm();
    this.watchdog = setTimeout(() => { console.warn("Haven sync: no reply from server"); void this.fail(); }, Sync.REPLY_TIMEOUT_MS);
  }
  private disarm() { if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; } }

  private async fail() {
    this.disarm();
    this.pushing = false;
    await this.setStatus("error");
    this.ws?.close();          // onclose schedules a reconnect with backoff
  }

  /**
   * Start over from the server's copy: clear local tables (not the outbox), re-apply unsent changes,
   * pull everything. Used when the server says this device is too far behind, and whenever it
   * rejects a change, so the screen never keeps showing something the server refused.
   */
  private async resyncFromScratch() {
    await this.db.transaction("rw", this.db.tables, async () => {
      for (const t of this.db.tables) if (t.name !== "outbox") await t.clear();
    });
    const pending = await this.db.outbox.toArray();
    for (const p of pending) { const t = this.db.table_(p.table); await t.put({ ...((await t.get(p.rowId)) ?? { id: p.rowId }), ...p.fields, id: p.rowId }); }
    this.send({ type: "pull", since: 0 });
  }

  private async cursor(): Promise<number> { return ((await this.db.meta.get("cursor"))?.v as number) ?? 0; }

  private async receive(msg: ServerMessage | { type: "reply" }) {
    if (msg.type === "reply") { this.onReplySignal?.(); return; }
    if (msg.type === "presence") { this.presenceListeners.forEach((fn) => fn(msg)); return; }
    if (msg.type === "resync") { await this.resyncFromScratch(); return; }   // offline longer than tombstones are kept
    if (msg.type === "error") { console.error("Haven sync: server error", msg.message ?? ""); await this.fail(); return; }
    if (msg.type === "too_old") { await this.setStatus("too_old"); this.ws?.close(); return; }
    if (msg.type === "changes") {
      await this.applyRemote(msg.rows);
      const cur = await this.cursor();
      if (msg.version > cur) await this.db.meta.put({ k: "cursor", v: msg.version });
      if (msg.more) { this.send({ type: "pull", since: msg.version }); return; }
      await this.flush();
      return;
    }
    if (msg.type === "ack") {
      const acked = await this.db.outbox.where("id").anyOf(msg.ids).primaryKeys();
      await this.db.outbox.bulkDelete(acked);
      this.pushing = false;
      if (msg.rejected?.length) {
        // The server refused some changes: show its version, not ours (they would never sync).
        console.warn("Haven sync: server rejected", msg.rejected.length, "change(s); reloading the server's copy");
        await this.resyncFromScratch();
        return;
      }
      await this.flush();
    }
  }

  /** Applies server rows, then re-applies any unsent local changes on top (last write wins per field). */
  private async applyRemote(rows: Record<string, unknown>[]) {
    const pending = await this.db.outbox.toArray();
    await this.db.transaction("rw", this.db.tables, async () => {
      for (const raw of rows) {
        const table = raw.table as TableName;
        const { table: _t, rowId, ...rest } = raw as Record<string, unknown> & { rowId?: string };
        const row: Row = { ...rest, id: "" };
        for (const c of JSON_COLS) if (typeof row[c] === "string") { try { row[c] = JSON.parse(row[c] as string); } catch { /* keep text */ } }
        row.id = table === "meals_items" ? itemId(String(row.trip_id), String(row.key)) : String(rowId ?? rest.id);
        const t = this.db.table_(table);
        const existing = (await t.get(row.id)) ?? {};
        const merged: Row = { ...existing, ...row };
        for (const p of pending) if (p.table === table && p.rowId === row.id) Object.assign(merged, p.fields);
        await t.put(merged);
      }
    });
  }

  /** Writes locally, queues for the server, and pushes if connected. */
  async mutate(table: TableName, rowId: string, fields: Record<string, unknown>) {
    const id = crypto.randomUUID();
    await this.db.transaction("rw", [this.db.table_(table), this.db.outbox], async () => {
      const t = this.db.table_(table);
      const existing = (await t.get(rowId)) ?? { id: rowId };
      await t.put({ ...existing, ...fields, id: rowId });
      await this.db.outbox.add({ id, table, rowId, fields } satisfies OutboxEntry);
    });
    await this.setStatus();
    void this.flush();
  }

  private async flush() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pushing) {
      if (this.ws?.readyState === WebSocket.OPEN && !this.pushing) await this.setStatus("synced");
      return;
    }
    const batch = await this.db.outbox.orderBy("seq").limit(PUSH_MAX).toArray();
    if (!batch.length) { await this.setStatus("synced"); return; }
    this.pushing = true;
    await this.setStatus("syncing");
    this.send({
      type: "push",
      mutations: batch.map((e) => ({
        id: e.id,
        table: e.table,
        rowId: e.table === "meals_items" ? e.rowId.split("|").slice(1).join("|") : e.rowId,
        fields: serialize(e.fields),
      })),
    });
  }
}

function serialize(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = JSON_COLS.has(k) && v != null && typeof v !== "string" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v;
  }
  return out;
}
