/**
 * To-dos core (PRD › To-dos plan): repeat dates, due state, time zones and who gets which
 * reminder when. Pure and dependency-free, shared by the app, the Worker and the tests.
 * Dates are "YYYY-MM-DD" in the household's time zone; times are "HH:MM".
 */

export type RepeatKind = "daily" | "weekly" | "biweekly" | "monthly" | "monthly_nth" | "yearly" | "after";
export interface Repeat { kind: RepeatKind; n?: number }   // n: days, for "after"

/* ── Calendar arithmetic on plain dates (no time zones involved) ── */
const parse = (d: string) => { const [y, m, day] = d.split("-").map(Number); return { y, m, day }; };
const iso = (y: number, m: number, day: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addDays(d: string, n: number): string {
  const { y, m, day } = parse(d);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export const weekday = (d: string) => { const { y, m, day } = parse(d); return new Date(Date.UTC(y, m - 1, day)).getUTCDay(); };
export const daysBetween = (a: string, b: string) => { const p = parse(a), q = parse(b); return Math.round((Date.UTC(q.y, q.m - 1, q.day) - Date.UTC(p.y, p.m - 1, p.day)) / 86_400_000); };
function addMonths(y: number, m: number, k: number) { const t = (y * 12 + (m - 1)) + k; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; }
/** nth (1–4) weekday of a month, or the last one (nth = -1). */
function nthWeekday(y: number, m: number, wd: number, nth: number): string {
  if (nth === -1) { const last = daysIn(y, m); const lw = new Date(Date.UTC(y, m - 1, last)).getUTCDay(); return iso(y, m, last - ((lw - wd + 7) % 7)); }
  const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((wd - firstWd + 7) % 7) + (nth - 1) * 7);
}
/** Which "nth weekday" a date is: 1–4, or -1 for a day in the last 7 days of a month past the 28th. */
export const nthOf = (d: string) => { const { day } = parse(d); return day > 28 ? -1 : Math.ceil(day / 7); };

/** The occurrence of `repeat` (anchored on `anchor`) in the period k steps after the anchor. */
function occurrence(r: Repeat, anchor: string, k: number): string {
  const { y, m, day } = parse(anchor);
  switch (r.kind) {
    case "daily": return addDays(anchor, k);
    case "weekly": return addDays(anchor, 7 * k);
    case "biweekly": return addDays(anchor, 14 * k);
    case "monthly": { const t = addMonths(y, m, k); return iso(t.y, t.m, Math.min(day, daysIn(t.y, t.m))); }
    case "monthly_nth": { const t = addMonths(y, m, k); return nthWeekday(t.y, t.m, weekday(anchor), nthOf(anchor)); }
    case "yearly": return iso(y + k, m, Math.min(day, daysIn(y + k, m)));
    case "after": return addDays(anchor, (r.n ?? 1) * k);
  }
}

/**
 * Next due date after ticking (or skipping) a repeating item on `today`. Fixed schedules move to their
 * first date after both the current due date and today, so a missed item never stacks up copies and
 * an early tick doesn't make it due again the next day. "N days after done" counts from today.
 */
export function nextDue(r: Repeat, due: string, today: string): string {
  if (r.kind === "after") return addDays(today, Math.max(1, r.n ?? 1));
  const after = due > today ? due : today;
  for (let k = 1; k < 5000; k++) { const d = occurrence(r, due, k); if (d > after) return d; }
  return addDays(after, 1);
}

export type DueState = "overdue" | "today" | "upcoming" | "none";
export const dueState = (due: string | null | undefined, today: string): DueState => (!due ? "none" : due < today ? "overdue" : due === today ? "today" : "upcoming");

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORD = (n: number) => { const t = n % 100; return t >= 11 && t <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`; };
const NTH = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" } as Record<number, string>;
/** "Every week on Tuesday", "Every month on the first Saturday", "3 days after it’s done". */
export function repeatLabel(r: Repeat, due?: string | null): string {
  const p = due ? parse(due) : null;
  switch (r.kind) {
    case "daily": return "Every day";
    case "weekly": return due ? `Every week on ${WD[weekday(due)]}` : "Every week";
    case "biweekly": return due ? `Every 2 weeks on ${WD[weekday(due)]}` : "Every 2 weeks";
    case "monthly": return p ? `Every month on the ${ORD(p.day)}` : "Every month";
    case "monthly_nth": return due ? `Every month on the ${NTH[nthOf(due)]} ${WD[weekday(due)]}` : "Every month";
    case "yearly": return p ? `Every year on ${p.day} ${MON[p.m - 1]}` : "Every year";
    case "after": return `${r.n ?? 1} day${(r.n ?? 1) === 1 ? "" : "s"} after it’s done`;
  }
}
/** Short form for item rows: "weekly", "monthly", "3 days after done". */
export function repeatShort(r: Repeat): string {
  return { daily: "daily", weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly", monthly_nth: "monthly", yearly: "yearly", after: `${r.n ?? 1} day${(r.n ?? 1) === 1 ? "" : "s"} after done` }[r.kind];
}
export function parseRepeat(v: unknown): Repeat | null {
  const r = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  return r && typeof r === "object" && typeof (r as Repeat).kind === "string" ? (r as Repeat) : null;
}

/* ── Time zones (Intl only; works in browsers, Workers and Node) ── */
function partsIn(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
const offsetAt = (ms: number, tz: string) => { const p = partsIn(ms, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
/** The instant when it is `date time` in `tz` (DST gaps move forward, overlaps take the first). */
export function zonedTimeToUtc(date: string, time: string, tz: string): number {
  const { y, m, day } = parse(date); const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, day, hh, mm);
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  return t;
}
export const dateInZone = (ms: number, tz: string) => { const p = partsIn(ms, tz); return iso(p.year, p.month, p.day); };

/* ── Reminders: who gets what, when (the Worker sends them) ── */
export interface RItem { id: string; list_id: string; title: string; due_date: string | null; due_time: string | null; assignee_id: string | null; done_at: number | null; deleted?: number }
export interface RList { id: string; name: string; checklist: number; deleted?: number }
export interface Reminder { key: string; users: string[]; title: string; body: string; url: string }
export interface PlanInput { tz: string; now: number; items: RItem[]; lists: RList[]; members: string[]; mutes: { user_id: string; list_id: string }[]; sent: Set<string>; digestTime?: string }

/** Late by up to this much still sends (e.g. the Worker was busy); older ones are skipped, not sent late. */
export const GRACE_MS = 6 * 3_600_000;
export const DIGEST_TIME = "10:00";

/**
 * Reminders due now (not yet sent, at most GRACE_MS late) and when the next one is due.
 * Timed items remind at their time; day-only items (today's and overdue) go into one digest at 10:00.
 * Recipients: the assignee, or everyone if unassigned, minus anyone who muted that list.
 * Reusable checklists and done items never remind.
 */
export function planReminders(p: PlanInput): { due: Reminder[]; nextAt: number | null } {
  const lists = new Map(p.lists.filter((l) => !l.deleted && !l.checklist).map((l) => [l.id, l]));
  const open = p.items.filter((i) => !i.deleted && !i.done_at && i.due_date && lists.has(i.list_id));
  const muted = new Set(p.mutes.map((m) => `${m.user_id}|${m.list_id}`));
  const who = (i: RItem) => (i.assignee_id ? [i.assignee_id] : p.members).filter((u) => !muted.has(`${u}|${i.list_id}`));
  const due: Reminder[] = []; const future: number[] = [];
  const today = dateInZone(p.now, p.tz);

  for (const i of open.filter((x) => x.due_time)) {
    const at = zonedTimeToUtc(i.due_date!, i.due_time!, p.tz);
    const key = `item|${i.id}|${i.due_date}|${i.due_time}`;
    if (at > p.now) { future.push(at); continue; }
    if (p.now - at > GRACE_MS || p.sent.has(key)) continue;
    const users = who(i);
    if (users.length) due.push({ key, users, title: i.title, body: `Due now · ${lists.get(i.list_id)!.name}`, url: `/m/todos/list/${i.list_id}` });
  }

  const dayOnly = open.filter((x) => !x.due_time);
  const digestAt = zonedTimeToUtc(today, p.digestTime ?? DIGEST_TIME, p.tz);
  const key = `digest|${today}`;
  if (digestAt <= p.now && p.now - digestAt <= GRACE_MS && !p.sent.has(key)) {
    const per = new Map<string, RItem[]>();
    for (const i of dayOnly.filter((x) => x.due_date! <= today)) for (const u of who(i)) per.set(u, [...(per.get(u) ?? []), i]);
    for (const [u, its] of per) {
      const late = its.filter((i) => i.due_date! < today).length;
      const names = its.slice(0, 3).map((i) => i.title).join(", ") + (its.length > 3 ? ` and ${its.length - 3} more` : "");
      due.push({ key, users: [u], title: its.length === 1 ? "1 to-do today" : `${its.length} to-dos today`, body: names + (late ? ` · ${late} overdue` : ""), url: "/m/todos" });
    }
  }
  // Next digest: today's if it's still ahead and something is due by today; otherwise the earliest day
  // from tomorrow on with a day-only item due (overdue items keep it daily until they're done).
  if (dayOnly.length) {
    if (digestAt > p.now && dayOnly.some((i) => i.due_date! <= today)) future.push(digestAt);
    else {
      const tomorrow = addDays(today, 1);
      const first = dayOnly.map((i) => (i.due_date! < tomorrow ? tomorrow : i.due_date!)).sort()[0];
      future.push(zonedTimeToUtc(first, p.digestTime ?? DIGEST_TIME, p.tz));
    }
  }
  return { due, nextAt: future.length ? Math.min(...future) : null };
}
