import { describe, expect, it } from "vitest";
import { addDays, dateInZone, dueState, isLate, nextDue, planReminders, repeatLabel, repeatShort, zonedTimeToUtc, type RItem } from "../src/index";

describe("nextDue", () => {
  it("weekly moves a week on from the due date", () => expect(nextDue({ kind: "weekly" }, "2026-11-24", "2026-11-24")).toBe("2026-12-01"));
  it("ticked early: the next one after the due date, not tomorrow", () => expect(nextDue({ kind: "weekly" }, "2026-11-24", "2026-11-23")).toBe("2026-12-01"));
  it("missed several times: first date after today, no stacking", () => expect(nextDue({ kind: "weekly" }, "2026-11-03", "2026-11-23")).toBe("2026-11-24"));
  it("every 2 weeks", () => expect(nextDue({ kind: "biweekly" }, "2026-11-21", "2026-11-23")).toBe("2026-12-05"));
  it("daily", () => expect(nextDue({ kind: "daily" }, "2026-11-20", "2026-11-23")).toBe("2026-11-24"));
  it("monthly keeps the date", () => expect(nextDue({ kind: "monthly" }, "2026-12-01", "2026-11-23")).toBe("2027-01-01"));
  it("monthly on the 31st clamps to short months", () => {
    expect(nextDue({ kind: "monthly" }, "2027-01-31", "2027-01-31")).toBe("2027-02-28");
    expect(nextDue({ kind: "monthly" }, "2027-01-31", "2027-03-01")).toBe("2027-03-31");
  });
  it("first Saturday of the month", () => expect(nextDue({ kind: "monthly_nth" }, "2026-11-07", "2026-11-07")).toBe("2026-12-05"));
  it("last Friday of the month", () => expect(nextDue({ kind: "monthly_nth" }, "2026-11-27", "2026-11-27")).toBe("2026-12-25"));
  it("yearly on 29 Feb falls back to 28 Feb", () => expect(nextDue({ kind: "yearly" }, "2028-02-29", "2028-02-29")).toBe("2029-02-28"));
  it("N days after done counts from today", () => expect(nextDue({ kind: "after", n: 3 }, "2026-11-20", "2026-11-23")).toBe("2026-11-26"));
});

describe("labels and state", () => {
  it("describes repeats", () => {
    expect(repeatLabel({ kind: "weekly" }, "2026-11-24")).toBe("Every week on Tuesday");
    expect(repeatLabel({ kind: "monthly" }, "2026-12-01")).toBe("Every month on the 1st");
    expect(repeatLabel({ kind: "monthly_nth" }, "2026-11-07")).toBe("Every month on the first Saturday");
    expect(repeatLabel({ kind: "after", n: 3 })).toBe("3 days after it’s done");
    expect(repeatShort({ kind: "biweekly" })).toBe("every 2 weeks");
  });
  it("due state", () => {
    expect(dueState("2026-11-21", "2026-11-23")).toBe("overdue");
    expect(dueState("2026-11-23", "2026-11-23")).toBe("today");
    expect(dueState(null, "2026-11-23")).toBe("none");
  });
});

describe("isLate", () => {
  const today = "2026-11-23";
  const item = (due_date?: string | null, due_time?: string | null) => ({ due_date, due_time });
  it("due today at a passed time is late", () => expect(isLate(item(today, "09:00"), today, "10:30")).toBe(true));
  it("due today at exactly the current minute is not late", () => expect(isLate(item(today, "10:30"), today, "10:30")).toBe(false));
  it("due today at a future time is not late", () => expect(isLate(item(today, "14:00"), today, "10:30")).toBe(false));
  it("due yesterday is late, with or without a time", () => {
    expect(isLate(item("2026-11-22", "23:59"), today, "10:30")).toBe(true);
    expect(isLate(item("2026-11-22"), today, "10:30")).toBe(true);
  });
  it("due tomorrow is not late", () => expect(isLate(item("2026-11-24", "00:00"), today, "10:30")).toBe(false));
  it("no due date is not late", () => {
    expect(isLate(item(null, "09:00"), today, "10:30")).toBe(false);
    expect(isLate(item(undefined, "09:00"), today, "10:30")).toBe(false);
  });
  it("due today with no time is not late", () => expect(isLate(item(today), today, "23:59")).toBe(false));
});

describe("time zones", () => {
  it("Singapore has no DST", () => expect(new Date(zonedTimeToUtc("2026-11-23", "10:00", "Asia/Singapore")).toISOString()).toBe("2026-11-23T02:00:00.000Z"));
  it("London in winter and summer", () => {
    expect(new Date(zonedTimeToUtc("2026-11-23", "10:00", "Europe/London")).toISOString()).toBe("2026-11-23T10:00:00.000Z");
    expect(new Date(zonedTimeToUtc("2026-07-01", "10:00", "Europe/London")).toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });
  it("New York across the DST change", () => {
    expect(new Date(zonedTimeToUtc("2026-03-07", "09:00", "America/New_York")).toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(new Date(zonedTimeToUtc("2026-03-09", "09:00", "America/New_York")).toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });
  it("local date of an instant", () => expect(dateInZone(Date.parse("2026-11-23T17:00:00Z"), "Asia/Singapore")).toBe("2026-11-24"));
  it("addDays across months", () => expect(addDays("2026-11-30", 1)).toBe("2026-12-01"));
});

describe("planReminders", () => {
  const tz = "Asia/Singapore";
  const at = (d: string, t: string) => zonedTimeToUtc(d, t, tz);
  const lists = [{ id: "chores", name: "Chores", checklist: 0 }, { id: "pack", name: "Packing", checklist: 1 }];
  const item = (o: Partial<RItem>): RItem => ({ id: "x", list_id: "chores", title: "T", due_date: null, due_time: null, assignee_id: null, done_at: null, ...o });
  const base = { tz, lists, members: ["wai", "mira", "jon"], mutes: [], sent: new Set<string>() };

  it("timed item reminds its assignee at its time, once", () => {
    const items = [item({ id: "plumber", title: "Call the plumber", due_date: "2026-11-23", due_time: "14:00", assignee_id: "wai" })];
    const before = planReminders({ ...base, items, now: at("2026-11-23", "13:00") });
    expect(before.due).toEqual([]); expect(before.nextAt).toBe(at("2026-11-23", "14:00"));
    const r = planReminders({ ...base, items, now: at("2026-11-23", "14:00") + 5_000 });
    expect(r.due).toHaveLength(1); expect(r.due[0].users).toEqual(["wai"]); expect(r.due[0].title).toBe("Call the plumber");
    expect(planReminders({ ...base, items, sent: new Set([r.due[0].key]), now: at("2026-11-23", "14:01") }).due).toEqual([]);
  });
  it("unassigned reminds everyone who hasn't muted the list", () => {
    const items = [item({ id: "p", due_date: "2026-11-23", due_time: "09:00" })];
    const r = planReminders({ ...base, items, mutes: [{ user_id: "jon", list_id: "chores" }], now: at("2026-11-23", "09:00") });
    expect(r.due[0].users).toEqual(["wai", "mira"]);
  });
  it("more than 6 hours late is skipped, not sent late", () => {
    const items = [item({ id: "p", due_date: "2026-11-23", due_time: "02:00" })];
    expect(planReminders({ ...base, items, now: at("2026-11-23", "09:00") }).due).toEqual([]);
  });
  it("day-only items go into one 10:00 digest per person, overdue included", () => {
    const items = [
      item({ id: "a", title: "Water the plants", due_date: "2026-11-23" }),
      item({ id: "b", title: "Change the bedsheets", due_date: "2026-11-21", assignee_id: "mira" }),
      item({ id: "c", title: "Clean the oven", due_date: "2026-12-01" }),
    ];
    const early = planReminders({ ...base, items, now: at("2026-11-23", "08:00") });
    expect(early.due).toEqual([]); expect(early.nextAt).toBe(at("2026-11-23", "10:00"));
    const r = planReminders({ ...base, items, now: at("2026-11-23", "10:00") });
    const mira = r.due.find((x) => x.users[0] === "mira")!;
    expect(mira.title).toBe("2 tasks today"); expect(mira.body).toBe("Water the plants, Change the bedsheets · 1 overdue");
    expect(r.due.find((x) => x.users[0] === "jon")!.title).toBe("1 task today");
    expect(new Set(r.due.map((x) => x.key))).toEqual(new Set(["digest|2026-11-23"]));
  });
  it("a day-only item next week schedules the digest for that day", () => {
    const items = [item({ id: "a", due_date: "2026-11-30" })];
    expect(planReminders({ ...base, items, now: at("2026-11-23", "12:00") }).nextAt).toBe(at("2026-11-30", "10:00"));
  });
  it("after today's digest, overdue items schedule tomorrow's", () => {
    const items = [item({ id: "a", due_date: "2026-11-20" })];
    expect(planReminders({ ...base, items, now: at("2026-11-23", "12:00") }).nextAt).toBe(at("2026-11-24", "10:00"));
  });
  it("checklists and done items never remind", () => {
    const items = [item({ id: "a", list_id: "pack", due_date: "2026-11-23", due_time: "09:00" }), item({ id: "b", due_date: "2026-11-23", due_time: "09:00", done_at: 1 })];
    const r = planReminders({ ...base, items, now: at("2026-11-23", "09:00") });
    expect(r.due).toEqual([]); expect(r.nextAt).toBeNull();
  });
});
