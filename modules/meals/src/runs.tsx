import { addDays } from "@haven/meals-core";
import { Button, Dialog, Field, Sheet } from "@haven/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";
import {
  cap, extrasOnRun, fmt, mealsOnRun, newId, plural, runColor, runIsEmpty, runName, runSummary, upcomingRuns, useMutate,
  type MealRow, type MealsData, type TripRow,
} from "./data";

/**
 * Grocery runs hold the meals you pick (decision, Nov 2026). These sheets are shared by Lists
 * (plan and manage runs) and Plan (put one meal on a run, in place).
 */

/** What an action changed, so a single Undo can put it back. */
/** What an action changed, so a single Undo puts all of it back (including a run it created). */
export interface RunUndo { text: string; meals: [string, string | null][]; restoreRuns: string[]; removeRuns?: string[] }

const title = (d: MealsData, m: MealRow) => d.recipes.find((r) => r.id === m.recipe_id)?.title ?? m.recipe_snapshot?.title ?? "Deleted recipe";
const mealLabel = (m: MealRow) => `${fmt(m.date)} ${m.slot}`;

/** Moves meals onto a run (or off any run), then removes runs left truly empty. A run that receives a meal in the same action is never removed — so an edited run is removed only when it ends up with no meals at all. */
async function assign(d: MealsData, put: ReturnType<typeof useMutate>["put"], changes: [MealRow, string | null][]) {
  const before: [string, string | null][] = changes.map(([m]) => [m.id, m.run_id ?? null]);
  for (const [m, runId] of changes) if ((m.run_id ?? null) !== runId) await put("meals_planned", m.id, { run_id: runId });
  const leaving = changes.filter(([m, to]) => m.run_id && m.run_id !== to).map(([m]) => m.id);
  const targets = new Set(changes.map(([, to]) => to).filter((x): x is string => !!x));
  const sources = [...new Set(changes.map(([m]) => m.run_id).filter((x): x is string => !!x))];
  const removed: TripRow[] = [];
  for (const id of sources) {
    if (targets.has(id)) continue; // a meal moves onto this run in the same action, so it can't be empty
    const run = d.trips.find((t) => t.id === id);
    if (run && run.status !== "finished" && runIsEmpty(d, run, leaving)) { await put("meals_trips", run.id, { deleted: 1 }); removed.push(run); }
  }
  return { before, removed };
}

export function RunPlanner({ data, run, focus, onClose, onUndo }: { data: MealsData; run?: TripRow; focus?: MealRow; onClose: () => void; onUndo: (u: RunUndo) => void }) {
  const { today, user } = useCtx();
  const m = useMutate();
  const editing = !!run;
  const [day, setDay] = useState<string | null>(run?.date ?? null);
  const [name, setName] = useState(run?.name ?? "");
  const [picked, setPicked] = useState<string[]>(run ? mealsOnRun(data, run).map((x) => x.id) : focus ? [focus.id] : []);
  const [busy, setBusy] = useState(false);

  const others = upcomingRuns(data).filter((t) => t.id !== run?.id);
  const runOf = (meal: MealRow) => (meal.run_id ? data.trips.find((t) => t.id === meal.run_id) : undefined);
  const from = day && day > today ? day : today;
  const eligible = data.meals.filter((x) => x.status === "planned" && x.date >= from).sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot));
  const free = (x: MealRow) => { const r = runOf(x); return !r || r.id === run?.id; };
  const movable = (x: MealRow) => runOf(x)?.status !== "finished";
  // Picked meals that aren't in the checklist below (past meals on this run, or ones before the day picked): shown separately so they're never silently dropped.
  const offList = data.meals.filter((x) => picked.includes(x.id) && !eligible.some((e) => e.id === x.id));

  function chooseDay(next: string) {
    setDay(next);
    if (editing || focus) {
      // Meals already on this run stay picked when the day moves: they're shown separately, not dropped by the day picker. Other picked meals just stop moving here (they stay on their own run).
      setPicked((p) => p.filter((id) => { const x = data.meals.find((m) => m.id === id); return !x || x.date >= next || (run && x.run_id === run.id); }));
      return;
    }
    // New run: tick meals without a run, up to the next run's day.
    const after = others.filter((t) => t.date > next).map((t) => t.date).sort()[0];
    setPicked(data.meals.filter((x) => x.status === "planned" && x.date >= next && !x.run_id && (!after || x.date < after)).map((x) => x.id));
  }
  const quick = (until: string | null) => {
    // The chips only retick what's in the checklist; meals already picked that aren't in it stay picked.
    const keep = offList.map((x) => x.id);
    setPicked(until === null ? keep : [...eligible.filter((x) => x.date <= until && free(x)).map((x) => x.id), ...keep]);
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const pickedMeals = data.meals.filter((x) => picked.includes(x.id));
  const leaving = pickedMeals.filter((x) => x.run_id && x.run_id !== run?.id).map((x) => x.id);
  // The run being edited empties too when every meal on it is unpicked and none is picked onto it.
  const runMeals = run ? mealsOnRun(data, run) : [];
  const selfEmptied = editing && runMeals.length > 0 && picked.length === 0 && !!run && runIsEmpty(data, run, runMeals.map((x) => x.id));
  const emptied = [
    ...others.filter((t) => mealsOnRun(data, t).some((x) => leaving.includes(x.id)) && runIsEmpty(data, t, leaving)),
    ...(selfEmptied && run ? [run] : []),
  ];
  const sameDay = day ? others.filter((t) => t.date === day).length : 0;

  async function save() {
    if (!day) return;
    setBusy(true);
    const runId = run?.id ?? newId();
    await m.put("meals_trips", runId, editing ? { date: day, name: name.trim() || null } : { date: day, kind: "regular", status: "upcoming", name: name.trim() || null });
    const changes: [MealRow, string | null][] = [
      ...pickedMeals.map((x) => [x, runId] as [MealRow, string | null]),
      ...(run ? mealsOnRun(data, run).filter((x) => !picked.includes(x.id)).map((x) => [x, null] as [MealRow, string | null]) : []),
    ];
    const { before, removed } = await assign(data, m.put, changes);
    if (!editing) await m.activity(`${user.name.split(" ")[0]} planned a grocery run for ${fmt(day)}`);
    const label = `${fmt(day)}${name.trim() ? ` · ${name.trim()}` : ""}`;
    // Only offer Undo when something else changed (a run was removed); a new run is visible on its own.
    if (removed.length) onUndo({
      text: `${editing ? "Saved" : `Planned the ${label} run`}. The ${removed.map((r) => runName(data, r)).join(" and ")} run had nothing left, so it was removed.`,
      meals: before, restoreRuns: removed.map((r) => r.id), removeRuns: editing ? [] : [runId],
    });
    onClose();
  }

  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const quickUntil = day ? [addDays(day, 1), addDays(day, 3)].filter((u) => eligible.some((x) => x.date <= u)) : [];
  let lastDate = "";

  return (
    <Sheet title={editing ? "Edit this run" : "Plan a grocery run"} onClose={onClose}>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>{focus ? `Pick a day on or before ${fmt(focus.date)} to shop for ${fmt(focus.date)} ${focus.slot}, then tick anything else to buy for.` : "Pick the day you’ll shop, then tick what to buy for."}</p>
      <h3 className="h-section-title">Shop on</h3>
      <div className="day-pick" role="radiogroup" aria-label="Shop on">
        {days.map((x) => {
          const n = others.filter((t) => t.date === x).length;
          return (
            <button key={x} type="button" role="radio" aria-checked={day === x} onClick={() => chooseDay(x)} disabled={!!focus && x > focus.date}
              aria-label={`${fmt(x, { weekday: "long", day: "numeric", month: "long" })}${n ? `, already ${plural(n, "run")}` : ""}${focus && x > focus.date ? `, after ${fmt(focus.date)}` : ""}`}>
              <span>{x === today ? "Today" : fmt(x, { weekday: "short" })}</span><b>{fmt(x, { day: "numeric" })}</b>{n > 0 && <small>{plural(n, "run")}</small>}
            </button>
          );
        })}
      </div>
      {!day && <p className="muted" style={{ fontSize: 13 }}>Pick a day first.</p>}
      {day && (<>
        <Field label="Name (optional)" value={name} maxLength={30} onChange={(e) => setName(e.target.value)}
          placeholder={sameDay ? `e.g. Market. Another run is already on ${fmt(day)}` : "e.g. Market, Costco"} />
        <h3 className="h-section-title" style={{ marginTop: 14 }}>Buy for</h3>
        <div className="chips" style={{ margin: "6px 0 8px" }}>
          {quickUntil.map((u) => <button key={u} type="button" className="h-chip" onClick={() => quick(u)}>Until {fmt(u)}</button>)}
          <button type="button" className="h-chip" onClick={() => quick("9999-12-31")}>All without a run</button>
          <button type="button" className="h-chip" onClick={() => quick(null)}>Clear</button>
        </div>
        {offList.length > 0 && (
          <div className="h-card pick-meals" role="group" aria-label="Already on this run">
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>Already on this run — these stay on it unless you untick them.</p>
            {offList.map((x) => {
              const r = runOf(x);
              return (
                <button key={x.id} type="button" role="checkbox" aria-checked className="pick-meal" onClick={() => toggle(x.id)}>
                  <span className="pick-meal__box" aria-hidden="true">✓</span>
                  <span className="h-row__main"><span>{fmt(x.date)} · {cap(x.slot)} · {title(data, x)}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{x.date < today ? "Past · " : ""}{r ? `on the ${runName(data, r)} run` : "Not on a run yet"}</span></span>
                </button>
              );
            })}
          </div>
        )}
        <div className="h-card pick-meals" role="group" aria-label="Meals to buy for">
          {!eligible.length && <p className="muted" style={{ margin: 0, padding: "10px 8px", fontSize: 13 }}>No meals planned from {fmt(day)} on. You can still plan the run for extra items.</p>}
          {eligible.map((x) => {
            const head = x.date !== lastDate ? <div className="pick-meals__day">{fmt(x.date, { weekday: "short", day: "numeric", month: "short" })}</div> : null;
            lastDate = x.date;
            const on = picked.includes(x.id); const r = runOf(x); const elsewhere = r && r.id !== run?.id; const locked = !movable(x);
            return (
              <div key={x.id}>{head}
                <button type="button" role="checkbox" aria-checked={on} disabled={locked} className="pick-meal" onClick={() => toggle(x.id)}>
                  <span className="pick-meal__box" aria-hidden="true">{on ? "✓" : ""}</span>
                  <span className="h-row__main"><span>{cap(x.slot)} · {title(data, x)}</span>
                    {elsewhere && <span className={`run-status run-status--${runColor(data, r!)}`}>{locked ? `Bought on the ${runName(data, r!)} run` : on ? `Moves here from the ${runName(data, r!)} run` : `On the ${runName(data, r!)} run · tick to move here`}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {emptied.length > 0 && <p className="muted" style={{ fontSize: 13 }}>The {emptied.map((t) => runName(data, t)).join(" and ")} run will have nothing left, so it will be removed (you can undo).</p>}
        <Button block loading={busy} onClick={save} style={{ marginTop: 10 }}>{editing ? "Save" : "Plan run"} · {plural(picked.length, "meal")}</Button>
      </>)}
    </Sheet>
  );
}

/** From a meal on Plan: put it on a run in one tap, start a new run, or take it off. */
export function AssignSheet({ data, meal, onNewRun, onClose, onUndo }: { data: MealsData; meal: MealRow; onNewRun: () => void; onClose: () => void; onUndo: (u: RunUndo) => void }) {
  const m = useMutate();
  const current = meal.run_id ? data.trips.find((t) => t.id === meal.run_id) : undefined;
  const fits = upcomingRuns(data).filter((t) => t.date <= meal.date && t.id !== current?.id);
  async function move(to: TripRow | null) {
    const { before, removed } = await assign(data, m.put, [[meal, to?.id ?? null]]);
    onUndo({ text: `${to ? `On the ${runName(data, to)} run` : "Taken off its run"}${removed.length ? `. The ${removed.map((r) => runName(data, r)).join(" and ")} run had nothing left, so it was removed` : ""}.`, meals: before, restoreRuns: removed.map((r) => r.id) });
    onClose();
  }
  return (
    <Sheet title={`${cap(meal.slot)}, ${fmt(meal.date)}`} onClose={onClose}>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>{title(data, meal)} · {current ? `on the ${runName(data, current)} run` : "not on any grocery run yet"}</p>
      <div className="h-stack">
        {fits.map((t) => (
          <button key={t.id} type="button" className="h-row settings-row" onClick={() => move(t)}>
            <span className={`run-dot run-dot--${runColor(data, t)}`} aria-hidden="true" />
            <span className="h-row__main"><span className="h-row__title">{current ? "Move to" : "Add to"} the {runName(data, t)} run</span><span className="h-row__sub">{runSummary(data, t)} so far</span></span>
          </button>
        ))}
        <button type="button" className="h-row settings-row" onClick={onNewRun}>
          <span aria-hidden="true" style={{ fontSize: 18, width: 9, textAlign: "center" }}>+</span>
          <span className="h-row__main"><span className="h-row__title">New grocery run…</span><span className="h-row__sub">Pick a day on or before {fmt(meal.date)}</span></span>
        </button>
        {current && current.status !== "finished" && <Button variant="danger" block onClick={() => move(null)}>Take off the {runName(data, current)} run</Button>}
        <Button variant="secondary" block onClick={onClose}>Done</Button>
      </div>
    </Sheet>
  );
}

/** A run's details: meals, extras, open list, edit, cancel. */
export function RunSheet({ data, run, onEdit, onClose, onUndo }: { data: MealsData; run: TripRow; onEdit: () => void; onClose: () => void; onUndo: (u: RunUndo) => void }) {
  const m = useMutate();
  const [confirm, setConfirm] = useState(false);
  const meals = mealsOnRun(data, run);
  const extras = extrasOnRun(data, run);
  async function cancel() {
    const before: [string, string | null][] = meals.map((x) => [x.id, run.id]);
    for (const x of meals) await m.put("meals_planned", x.id, { run_id: null });
    await m.put("meals_trips", run.id, { deleted: 1 });
    onUndo({ text: `${runName(data, run)} run cancelled.`, meals: before, restoreRuns: [run.id] });
    onClose();
  }
  return (
    <Sheet title={`${runName(data, run)} run`} onClose={onClose}>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>{runSummary(data, run)}</p>
      <ul className="plain h-card cover">
        {meals.map((x) => <li key={x.id}>{mealLabel(x)}<br /><span className="muted">{title(data, x)}</span></li>)}
        {extras.map((x) => <li key={x.id}>{x.label} <span className="muted">· extra item</span></li>)}
        {!meals.length && !extras.length && <li className="muted">Nothing on this run yet.</li>}
      </ul>
      <div className="h-stack" style={{ marginTop: 12 }}>
        <Link className="h-btn h-btn--primary h-btn--block" to={`/m/meals/lists/${run.id}`}>Open list</Link>
        <Button variant="secondary" block onClick={onEdit}>Edit day, name or meals</Button>
        <Button variant="danger" block onClick={() => (data.items.some((i) => i.trip_id === run.id && i.checked) ? setConfirm(true) : cancel())}>Cancel this run</Button>
        <Button variant="secondary" block onClick={onClose}>Done</Button>
      </div>
      {confirm && (
        <Dialog title={`Cancel the ${runName(data, run)} run?`} body="Some items on its list are already bought and stay recorded. Its meals go back to “No grocery run yet”." onClose={() => setConfirm(false)}>
          <Button variant="danger" onClick={cancel}>Cancel run</Button>
          <Button variant="text" onClick={() => setConfirm(false)}>Keep it</Button>
        </Dialog>
      )}
    </Sheet>
  );
}

/** Puts back what a run action changed. */
export async function undoRun(put: ReturnType<typeof useMutate>["put"], u: RunUndo) {
  for (const id of u.removeRuns ?? []) await put("meals_trips", id, { deleted: 1 });
  for (const id of u.restoreRuns) await put("meals_trips", id, { deleted: 0 });
  for (const [mealId, runId] of u.meals) await put("meals_planned", mealId, { run_id: runId });
}
