import { buildLines } from "@haven/meals-core";
import { Button, Dialog } from "@haven/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "./Plan";
import { useCtx } from "./ctx";
import { progressOf, RunProgress } from "./progress";
import { amount, fmt, plural, ingredientOf, listFor, mealOf, mealsOnRun, newId, runColor, runName, runSummary, toRecipe, upcomingRuns, useMealsData, useMutate, type MealsData, type TripRow } from "./data";
import { RunPlanner, RunSheet, undoRun, type RunUndo } from "./runs";
import { UndoToast } from "./RecipeEditor";
import { Icon } from "@haven/ui";
import { ModuleShell } from "./shell";

export interface FinalLine { key: string; name: string; qty?: number; unit?: string; base: number; section: string }

export function Lists() {
  const { today, household } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const [moving, setMoving] = useState<TripRow | null>(null);
  const [planner, setPlanner] = useState<{ run?: TripRow } | null>(null);
  const [sheet, setSheet] = useState<TripRow | null>(null);
  const [undo, setUndo] = useState<RunUndo | null>(null);
  if (!d) return <ModuleShell title="Lists" tab="lists"><Skeleton /></ModuleShell>;
  // Runs are planned here (decision, Nov 2026); a run holds the meals you pick.
  const upcoming = upcomingRuns(d);
  const done = d.trips.filter((t) => t.status === "finished").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const next = upcoming.find((t) => t.date >= today);
  const without = d.meals.filter((x) => x.status === "planned" && x.date >= today && !x.run_id).sort((a, b) => a.date.localeCompare(b.date));

  // Added since a finished trip (PRD › Edge cases › Trips and windows).
  const added = done.map((t) => {
    const final = (t.final_lines as FinalLine[] | undefined) ?? [];
    const now = listFor(d, t, household.measurement).rows.map((r) => r.line);
    const extra = now.filter((l) => { const f = final.find((x) => x.key === l.key); return !f || l.base > f.base + 1e-9; })
      .map((l) => ({ key: l.key, name: ingredientOf(d, l.ingredientId)?.name ?? "?", base: l.base - (final.find((x) => x.key === l.key)?.base ?? 0), shown: l.shown, section: ingredientOf(d, l.ingredientId)?.section ?? "other" }));
    return { trip: t, extra, lines: now };
  }).filter((x) => x.extra.length);

  async function carry(from: TripRow, to: TripRow, list: { key: string; name: string; shown: { qty?: number; unit?: string }; section: string }[], lines: FinalLine[] | null) {
    for (const x of list) await m.item(to.id, `extra_${newId()}`, { label: x.name, qty: x.shown.qty ?? null, unit: x.shown.unit ?? null, section: x.section, carried_from: from.id });
    if (lines) await m.put("meals_trips", from.id, { final_lines: lines });
  }

  return (
    <ModuleShell title="Lists" tab="lists">
      <Button block onClick={() => setPlanner({})}>+ Plan a grocery run</Button>
      {without.length > 0 && (upcoming.length > 0 || done.length > 0) && (
        <button className="note-card" onClick={() => setPlanner({})}>
          <strong>{plural(without.length, "meal")} not on any run</strong>
          <span>{without.slice(0, 4).map((x) => `${fmt(x.date)} ${x.slot}`).join(", ")}{without.length > 4 ? `, +${without.length - 4} more` : ""}</span>
        </button>
      )}
      {!upcoming.length && !added.length && <div className="empty-state"><h2>No upcoming grocery runs</h2><p className="muted">Plan one: pick the day you’ll shop and tick the meals to buy for. Its list builds itself.</p></div>}
      {added.map(({ trip, extra, lines }) => {
        const snapshot = lines.map((l) => ({ key: l.key, name: ingredientOf(d, l.ingredientId)?.name ?? "?", qty: l.shown.qty, unit: l.shown.unit, base: l.base, section: ingredientOf(d, l.ingredientId)?.section ?? "other" }));
        return (
          <section key={trip.id} className="h-card h-stack" style={{ padding: 16, borderColor: "var(--haven-accent-2)" }}>
            <strong>{extra.length} {extra.length === 1 ? "item" : "items"} added since the {fmt(trip.date)} grocery run</strong>
            <span>{extra.map((x) => `${x.name}${amount(x.shown.qty, x.shown.unit) ? ` · ${amount(x.shown.qty, x.shown.unit)}` : ""}`).join(" · ")}</span>
            {next && <Button onClick={() => carry(trip, next, extra, snapshot)}>Add to the {runName(d, next)} run</Button>}
            <Button variant="secondary" onClick={async () => { const id = newId(); await m.put("meals_trips", id, { date: today, kind: "regular", status: "upcoming", name: "Top-up" }); await carry(trip, { id, date: today, kind: "regular", status: "upcoming" } as TripRow, extra, snapshot); }}>Start a top-up run today</Button>
          </section>
        );
      })}
      {upcoming.map((t) => {
        const l = listFor(d, t, household.measurement);
        const overdue = t.date < today;
        const meals = mealsOnRun(d, t);
        return (
          <div key={t.id} className={`trip-card trip-${runColor(d, t)}`}>
            <div className="spread" style={{ alignItems: "flex-start" }}>
              <Link to={`/m/meals/lists/${t.id}`} className="trip-card__link" style={{ flex: 1 }}>
                <span className="spread"><strong style={{ fontSize: 20 }}>{runName(d, t)}</strong>{overdue && <span className="h-badge badge--accent2">Overdue</span>}</span>
                <span className={`run-status run-status--${runColor(d, t)}`} style={{ margin: 0 }}>{runSummary(d, t)}</span>
                {meals.length > 0 && <span className="trip-card__sub">{meals.map((x) => `${fmt(x.date)} ${x.slot}`).join(" · ")}</span>}
              </Link>
              <button className="h-icon-btn" aria-label={`Manage the ${runName(d, t)} run`} onClick={() => setSheet(t)}>{Icon.more}</button>
            </div>
            <Link to={`/m/meals/lists/${t.id}`} className="trip-card__link" tabIndex={-1} aria-hidden="true">
              <RunProgress p={progressOf(l)} strong />
            </Link>
            {overdue && <Button onClick={() => setMoving(t)}>Shop today instead</Button>}
          </div>
        );
      })}
      {done.length > 0 && <h2 className="h-section-title" style={{ marginTop: 12 }}>Done</h2>}
      {done.map((t) => (
        <div key={t.id} className="h-row">
          <Link to={`/m/meals/lists/${t.id}`} className="h-row__main" style={{ color: "inherit", textDecoration: "none" }}><span className="h-row__title">{fmt(t.date, { weekday: "short", month: "short", day: "numeric" })} · Done</span>
            <span className="h-row__sub">{((t.final_lines as FinalLine[] | undefined) ?? []).length} items{(t.reopen_until ?? 0) > Date.now() ? ` · reopen until ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(t.reopen_until!)}` : ""}</span></Link>
          {(t.reopen_until ?? 0) > Date.now() && <Button variant="secondary" onClick={() => m.put("meals_trips", t.id, { status: "upcoming", finished_at: null })}>Reopen</Button>}
        </div>
      ))}
      {moving && <MoveTrip trip={moving} data={d} onClose={() => setMoving(null)} />}
      {planner && <RunPlanner data={d} run={planner.run} onUndo={setUndo} onClose={() => setPlanner(null)} />}
      {sheet && <RunSheet data={d} run={sheet} onUndo={setUndo} onClose={() => setSheet(null)} onEdit={() => { setPlanner({ run: sheet }); setSheet(null); }} />}
      {undo && <UndoToast text={undo.text} onUndo={() => { void undoRun(m.put, undo); setUndo(null); }} onDone={() => setUndo(null)} />}
    </ModuleShell>
  );
}

function MoveTrip({ trip, data, onClose }: { trip: TripRow; data: MealsData; onClose: () => void }) {
  const { today, household } = useCtx();
  const m = useMutate();
  const [drop, setDrop] = useState(true);
  const past = listFor(data, trip, household.measurement).meals.filter((x) => x.date < today);
  const recipes = new Map(data.recipes.map((r) => [r.id, toRecipe(r, data)]));
  const pastLines = buildLines(past, recipes, household.measurement);
  const futureKeys = new Set(buildLines(listFor(data, trip, household.measurement).meals.filter((x) => x.date >= today), recipes, household.measurement).map((l) => l.key));
  const onlyPast = pastLines.filter((l) => !futureKeys.has(l.key));
  async function go() {
    await m.put("meals_trips", trip.id, { date: today, status: "upcoming" });
    // Past meals can't be bought for any more: take them off the run if you drop their items.
    if (drop) for (const x of mealsOnRun(data, trip).filter((x) => x.date < today)) await m.put("meals_planned", x.id, { run_id: null });
    // Keeping them: the past meals stay on the run, so their items stay on the list once (no extra copies).
    onClose();
  }
  return (
    <Dialog title={`Move this grocery run to today, ${fmt(today)}?`} body={onlyPast.length ? `${past.map((p) => data.recipes.find((r) => r.id === p.recipeId)?.title).filter(Boolean).join(", ")} ${past.length === 1 ? "is" : "are"} in the past. These items were only for ${past.length === 1 ? "that meal" : "those meals"}:` : "Meals before today will no longer be on this list."} onClose={onClose}>
      {onlyPast.length > 0 && <ul style={{ margin: 0 }}>{onlyPast.map((l) => <li key={l.key}>{ingredientOf(data, l.ingredientId)?.name} · {amount(l.shown.qty, l.shown.unit)}</li>)}</ul>}
      {onlyPast.length > 0 && <label className="chips"><input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} /> Drop them — I’ll cook those meals another day or skip them</label>}
      <Button onClick={go}>Move run</Button><Button variant="text" onClick={onClose}>Cancel</Button>
    </Dialog>
  );
}

export { mealOf };
