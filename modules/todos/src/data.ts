import { addDays, isLate, parseRepeat, type Repeat } from "@haven/todos-core";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useCtx } from "./ctx";

export interface TList { id: string; name: string; emoji?: string | null; position: number; checklist: number; created_by?: string | null; deleted?: number }
export interface TItem {
  id: string; list_id: string; title: string; note?: string | null; due_date?: string | null; due_time?: string | null; repeat?: Repeat | null;
  assignee_id?: string | null; position: number; checked?: number; done_at?: number | null; done_by?: string | null;
  last_done_at?: number | null; last_done_by?: string | null; created_by?: string | null; created_at?: number | null; deleted?: number;
}
export interface TData { lists: TList[]; items: TItem[]; muted: Set<string> }

/** Everything To-dos shows, live from the device (offline-first, like Meals). */
export function useTodos(): TData | undefined {
  const { db, user } = useCtx();
  return useLiveQuery(async () => {
    const [lists, items, mutes] = await Promise.all([db.todos_lists.toArray(), db.todos_items.toArray(), db.todos_mutes.toArray()]);
    const live = new Set(lists.filter((l) => !l.deleted).map((l) => l.id));
    return {
      lists: (lists as unknown as TList[]).filter((l) => !l.deleted).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name)),
      items: (items as unknown as TItem[]).filter((i) => !i.deleted && live.has(i.list_id)).map((i) => ({ ...i, repeat: parseRepeat(i.repeat) })),
      muted: new Set((mutes as unknown as { user_id: string; list_id: string; deleted?: number }[]).filter((m) => !m.deleted && m.user_id === user.id).map((m) => m.list_id)),
    };
  }, [db, user.id]);
}

/** Writes go through sync (outbox → household's sync object), so they work offline. */
export function useMutate() {
  const { sync, user } = useCtx();
  return {
    list: (id: string, f: Partial<TList>) => sync.mutate("todos_lists", id, f as Record<string, unknown>),
    item: (id: string, f: Partial<TItem>) => sync.mutate("todos_items", id, f as Record<string, unknown>),
    mute: (listId: string, muted: boolean) => sync.mutate("todos_mutes", `${user.id}|${listId}`, { user_id: user.id, list_id: listId, deleted: muted ? 0 : 1 }),
    activity: (text: string) => sync.mutate("activity", crypto.randomUUID(), { module_id: "todos", member_id: user.id, text, at: Date.now() }),
  };
}

export const newId = () => crypto.randomUUID();
const DONE_VISIBLE_DAYS = 7;
/** One-time items ticked more than 7 days ago no longer show (decision, Nov 2026); the server purges them later. */
export const visibleDone = (i: TItem, now = Date.now()) => !!i.done_at && now - i.done_at < DONE_VISIBLE_DAYS * 86_400_000;

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const utc = (d: string) => { const [y, m, day] = d.split("-").map(Number); return Date.UTC(y, m - 1, day); };
export const dayLabel = (d: string, today: string) => (d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : d === addDays(today, -1) ? "Yesterday" : fmtDay.format(utc(d)));
export const timeLabel = (t: string) => { const [h, m] = t.split(":").map(Number); return fmtTime.format(Date.UTC(2000, 0, 1, h, m)); };
export const whenLabel = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(ms);
export const firstName = (n?: string | null) => (n ?? "Someone").split(" ")[0];

/** "HH:MM" now in the household's time zone, refreshed every 30 seconds (so a timed task turns late on time). */
export function useNowHM(tz: string) {
  const read = () => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(Date.now());
  const [hm, setHm] = useState(read);
  useEffect(() => { const t = setInterval(() => setHm(read()), 30_000); return () => clearInterval(t); }, [tz]);
  return hm;
}
/** Late: due on an earlier day, or today at a time that has passed — now in @haven/todos-core, shared with the console tile. */
export { isLate };
