import { addDays, shoppingWindows } from "@haven/meals-core";
import { Button, Dialog, Icon, Sheet, Stepper } from "@haven/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";
import { cap, fmt, ingredientOf, listFor, newId, plural, sectionName, SLOTS, tripOf, useMealsData, useMutate, type MealRow, type MealsData, type TripRow } from "./data";
import { ModuleShell } from "./shell";
import { UndoToast } from "./RecipeEditor";

/**
 * Plan (decision, Nov 2026: "A + fix in place"). Grocery runs live in one strip at the top; adding one
 * shows which meals it will cover before you confirm. Days never re-group or move. Each upcoming meal
 * says which run it's on, and "No grocery run yet ›" opens the same sheet with that day picked.
 */
export function Plan() {
  const { today } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<MealRow | null>(null);
  const [runSheet, setRunSheet] = useState<TripRow | null>(null);
  const [planSheet, setPlanSheet] = useState<{ day: string | null } | null>(null);
  const [confirm, setConfirm] = useState<TripRow | null>(null);
  const [undo, setUndo] = useState<TripRow | null>(null);

  // Sliding window (decision, Nov 2026): today and the next six days; arrows move a week at a time.
  const start = addDays(today, 7 * offset);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  if (!d) return <ModuleShell title="Plan" tab="plan"><Skeleton /></ModuleShell>;
  const runs = runsOf(d);
  const upcoming = runs.regular.filter((t) => t.status !== "finished");
  const mealsOn = (day: string) => d.meals.filter((x) => x.date === day && x.status === "planned").sort((a, b) => SLOTS.indexOf(a.slot as never) - SLOTS.indexOf(b.slot as never));
  const uncovered = d.meals.filter((x) => x.status === "planned" && x.date >= today && !runs.covering(x.date));
  const empty = !d.meals.some((x) => x.status === "planned" && x.date >= start && x.date <= days[6]);

  async function cancel(run: TripRow) {
    setRunSheet(null);
    if (d!.items.some((i) => i.trip_id === run.id && i.checked)) { setConfirm(run); return; }
    await m.put("meals_trips", run.id, { deleted: 1 });
    setUndo(run);
  }

  return (
    <ModuleShell title="Plan" tab="plan" header={
      <div className="week-switch h-card">
        <button className="h-icon-btn" aria-label="Previous 7 days" onClick={() => setOffset(offset - 1)}>‹</button>
        <div className="center-text"><strong>{fmt(days[0], { month: "short", day: "numeric" })} – {fmt(days[6], { month: "short", day: "numeric" })}</strong>
          <div className="muted" style={{ fontSize: 12 }}>{offset === 0 ? "Today onwards" : <button className="linklike" onClick={() => setOffset(0)}>Back to today</button>}</div></div>
        <button className="h-icon-btn" aria-label="Next 7 days" onClick={() => setOffset(offset + 1)}>›</button>
      </div>}>
      <section className="runs h-card" aria-labelledby="runs-h">
        <h2 id="runs-h" className="h-section-title">Grocery runs</h2>
        <div className="chips">
          {upcoming.map((run) => {
            const n = runs.mealsOf(run).length; const overdue = run.date < today;
            return (
              <button key={run.id} className="run-chip" onClick={() => setRunSheet(run)}
                aria-label={`${fmt(run.date, { weekday: "long", day: "numeric", month: "long" })} grocery run, ${overdue ? "overdue" : plural(n, "meal")}`}>
                <span className={`run-dot run-dot--${runs.colorOf(run.id)}`} aria-hidden="true" />
                {fmt(run.date)} · {overdue ? "overdue" : plural(n, "meal")}
              </button>
            );
          })}
          <button className="run-chip run-chip--add" onClick={() => setPlanSheet({ day: null })}>+ Add run</button>
        </div>
        {!upcoming.length && <p className="runs__hint">No runs planned. Add one and its list builds itself from the meals it covers.</p>}
        {upcoming.length > 0 && uncovered.length > 0 && <p className="runs__hint">{plural(uncovered.length, "meal")} {uncovered.length === 1 ? "has" : "have"} no grocery run yet.</p>}
      </section>
      {empty && (
        <section className="h-card h-stack" style={{ padding: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Nothing planned for the next 7 days</h2>
          <p className="muted" style={{ margin: 0 }}>Add meals to days, then add a grocery run to shop for them.</p>
          {d.recipes.length ? <Button onClick={() => setAdding(days.find((x) => x >= today) ?? days[0])}>Add a meal</Button> : <Link className="h-btn h-btn--primary" to="/m/meals/recipes/new">Add your first recipe</Link>}
        </section>
      )}
      <div className="plan-layout"><div className="plan-days">
        {days.map((day) => {
          const meals = mealsOn(day); const past = day < today; const run = runs.regular.find((t) => t.date === day);
          return (
            <div key={day} className={`day h-card${past ? " day--past" : ""}${day === today ? " day--today" : ""}`}>
              <div className="day__date"><span>{day === today ? "Today" : fmt(day, { weekday: "short" })}</span><strong>{fmt(day, { day: "numeric" })}</strong></div>
              <div className="day__meals">
                {run && <button className={`run-tag run-tag--${runs.colorOf(run.id)}`} onClick={() => setRunSheet(run)}>Grocery run</button>}
                {meals.map((x) => {
                  const cov = past ? undefined : runs.covering(x.date);
                  return (
                    <div key={x.id} className="meal-wrap">
                      <button className="meal" onClick={() => setOpen(x)}>
                        <span className="meal__slot">{cap(x.slot)}</span><span>{d.recipes.find((r) => r.id === x.recipe_id)?.title ?? x.recipe_snapshot?.title ?? "Deleted recipe"}</span>
                      </button>
                      {!past && (cov
                        ? <span className={`run-status run-status--${runs.colorOf(cov.id)}`}><span className={`run-dot run-dot--${runs.colorOf(cov.id)}`} aria-hidden="true" />On the {fmt(cov.date)} run</span>
                        : <button className="run-status run-status--none" onClick={() => setPlanSheet({ day: x.date })}><span className="run-dot run-dot--none" aria-hidden="true" />No grocery run yet ›</button>)}
                    </div>
                  );
                })}
                {!past && <button className="add-meal" onClick={() => setAdding(day)}>+ Add meal</button>}
              </div>
            </div>
          );
        })}
      </div><NextTripPanel data={d} /></div>
      {adding && <AddMeal day={adding} data={d} onClose={() => setAdding(null)} />}
      {open && <MealSheet meal={open} data={d} onClose={() => setOpen(null)} />}
      {planSheet && <PlanRunSheet data={d} initial={planSheet.day} onClose={() => setPlanSheet(null)} />}
      {runSheet && <RunSheet data={d} run={runSheet} onCancel={() => cancel(runSheet)} onClose={() => setRunSheet(null)} />}
      {confirm && (
        <Dialog title={`Cancel the ${fmt(confirm.date)} grocery run?`} body="Some items on its list are already bought and stay recorded. Unbought items move to the previous grocery run." onClose={() => setConfirm(null)}>
          <Button variant="danger" onClick={async () => { await m.put("meals_trips", confirm.id, { deleted: 1 }); setConfirm(null); }}>Cancel grocery run</Button>
          <Button variant="text" onClick={() => setConfirm(null)}>Keep it</Button>
        </Dialog>
      )}
      {undo && <UndoToast text={`${fmt(undo.date)} grocery run cancelled`} onUndo={() => { void m.put("meals_trips", undo.id, { deleted: 0 }); setUndo(null); }} onDone={() => setUndo(null)} />}
    </ModuleShell>
  );
}

/** Regular grocery runs, which run covers a date, and the colour each run keeps everywhere (1–4). */
function runsOf(d: MealsData, extraDate?: string) {
  const regular = d.trips.filter((t) => t.kind === "regular");
  const trips = regular.map(tripOf).concat(extraDate ? [{ id: "__new", date: extraDate, kind: "regular" as const }] : []);
  const windows = shoppingWindows(trips);
  const coveringId = (date: string) => windows.find((w) => date >= w.from && date <= w.to)?.tripId;
  return {
    regular,
    covering: (date: string) => { const id = coveringId(date); return id ? regular.find((t) => t.id === id) : undefined; },
    coveringId,
    mealsOf: (run: TripRow) => d.meals.filter((x) => x.status === "planned" && coveringId(x.date) === run.id),
    colorOf: (id: string) => (regular.findIndex((t) => t.id === id) % 4) + 1,
  };
}

function PlanRunSheet({ data, initial, onClose }: { data: MealsData; initial: string | null; onClose: () => void }) {
  const { today } = useCtx();
  const m = useMutate();
  const taken = new Set(data.trips.filter((t) => t.kind === "regular").map((t) => t.date));
  // A meal's day can be in the past only if it's today's; otherwise default to the meal's own day.
  const first = initial && initial >= today && !taken.has(initial) ? initial : null;
  const [pick, setPick] = useState<string | null>(first);
  const choices = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const now = runsOf(data);
  const after = runsOf(data, pick ?? undefined);
  const covered = pick ? data.meals.filter((x) => x.status === "planned" && x.date >= today && after.coveringId(x.date) === "__new").sort((a, b) => a.date.localeCompare(b.date)) : [];
  const moved = covered.filter((x) => now.covering(x.date));
  const title = (x: MealRow) => data.recipes.find((r) => r.id === x.recipe_id)?.title ?? "Deleted recipe";

  return (
    <Sheet title="Plan a grocery run" onClose={onClose}>
      <p className="muted" style={{ margin: "0 0 10px" }}>Which day will you shop?</p>
      <div className="day-pick" role="radiogroup" aria-label="Day">
        {choices.map((day) => (
          <button key={day} type="button" role="radio" aria-checked={pick === day} disabled={taken.has(day)} onClick={() => setPick(day)}
            aria-label={`${fmt(day, { weekday: "long", day: "numeric", month: "long" })}${taken.has(day) ? ", already a grocery run" : ""}`}>
            <span>{day === today ? "Today" : fmt(day, { weekday: "short" })}</span><b>{fmt(day, { day: "numeric" })}</b>
          </button>
        ))}
      </div>
      {!pick && <p className="muted" style={{ fontSize: 13 }}>Pick a day to see which meals it will cover.</p>}
      {pick && (
        <div className="h-stack" style={{ gap: 10 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>It will cover these meals, until your next run:</p>
          <ul className="plain h-card cover">
            {covered.length ? covered.map((x) => <li key={x.id}>{fmt(x.date)} · {cap(x.slot)}<br /><span className="muted">{title(x)}</span></li>)
              : <li className="muted">No meals between {fmt(pick)} and your next run yet. You can still plan it.</li>}
          </ul>
          {moved.length > 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{moved.map((x) => `${fmt(x.date)} ${x.slot}`).join(", ")} will move here from the {fmt(now.covering(moved[0].date)!.date)} run.</p>}
          <Button block onClick={async () => { await m.put("meals_trips", newId(), { date: pick, kind: "regular", status: "upcoming" }); onClose(); }}>Plan run for {fmt(pick)}</Button>
        </div>
      )}
    </Sheet>
  );
}

function RunSheet({ data, run, onCancel, onClose }: { data: MealsData; run: TripRow; onCancel: () => void; onClose: () => void }) {
  const { today } = useCtx();
  const runs = runsOf(data);
  const meals = runs.mealsOf(run).sort((a, b) => a.date.localeCompare(b.date));
  const title = (x: MealRow) => data.recipes.find((r) => r.id === x.recipe_id)?.title ?? "Deleted recipe";
  return (
    <Sheet title={`${fmt(run.date, { weekday: "short", day: "numeric", month: "short" })} grocery run`} onClose={onClose}>
      <p className="muted" style={{ margin: "0 0 10px" }}>{run.date < today ? "This run’s date has passed. Open its list to finish it, or shop today instead from Lists." : "Buys everything for these meals:"}</p>
      <ul className="plain h-card cover">
        {meals.length ? meals.map((x) => <li key={x.id}>{fmt(x.date)} · {cap(x.slot)}<br /><span className="muted">{title(x)}</span></li>)
          : <li className="muted">No meals before your next run yet.</li>}
      </ul>
      <div className="h-stack" style={{ marginTop: 12 }}>
        <Link className="h-btn h-btn--primary h-btn--block" to={`/m/meals/lists/${run.id}`}>Open list</Link>
        <Button variant="secondary" block onClick={onCancel}>Cancel this run</Button>
      </div>
    </Sheet>
  );
}

function AddMeal({ day, data, onClose }: { day: string; data: MealsData; onClose: () => void }) {
  const { household, user } = useCtx();
  const m = useMutate();
  const [slot, setSlot] = useState<string>("dinner");
  const [q, setQ] = useState("");
  const lastUsed = (id: string) => data.meals.filter((x) => x.recipe_id === id).map((x) => x.date).sort().pop() ?? "";
  const list = data.recipes.filter((r) => !r.archived_at && r.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) => lastUsed(b.id).localeCompare(lastUsed(a.id)));
  const [pick, setPick] = useState(list[0]?.id);
  const recipe = data.recipes.find((r) => r.id === pick);
  const [servings, setServings] = useState<number | null>(null);
  const sv = servings ?? household.default_servings ?? recipe?.base_servings ?? 2;
  const ratio = recipe ? Math.round((sv / recipe.base_servings) * 100) / 100 : 1;

  async function add() {
    if (!recipe) return;
    await m.put("meals_planned", newId(), { date: day, slot, recipe_id: recipe.id, servings: sv, status: "planned" });
    await m.activity(`${user.name.split(" ")[0]} added ${recipe.title} to ${fmt(day)} ${slot}`);
    onClose();
  }

  return (
    <Sheet title={`Add to ${fmt(day, { weekday: "short", day: "numeric", month: "short" })}`} onClose={onClose}>
      <div className="h-stack" style={{ gap: 12 }}>
        <div role="radiogroup" aria-label="Meal slot" className="chips">{SLOTS.map((s) => <button key={s} type="button" role="radio" aria-checked={slot === s} className="h-chip" onClick={() => setSlot(s)}>{cap(s)}</button>)}</div>
        {recipe && <div className="h-row"><span className="h-row__main"><span className="h-row__title">Servings</span><span className="h-row__sub">{ratio === 1 ? `Same as the recipe (makes ${recipe.base_servings})` : `Recipe makes ${recipe.base_servings} · list quantities × ${ratio}`}</span></span><Stepper label="Servings" value={sv} max={50} onChange={setServings} /></div>}
        <label className="h-field"><span className="h-sr">Search recipes</span><input className="h-input" type="search" placeholder="Search recipes" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div role="radiogroup" aria-label="Recipe" className="h-stack pick-list">
          {list.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={pick === r.id} className="h-row pick" onClick={() => { setPick(r.id); setServings(null); }}>
              <span className="h-row__main"><span className="h-row__title">{r.title}</span><span className="h-row__sub">Makes {r.base_servings}{lastUsed(r.id) ? ` · last ${fmt(lastUsed(r.id), { month: "short", day: "numeric" })}` : ""}</span></span>
            </button>
          ))}
          {!list.length && <div className="h-empty"><strong>{q ? `No recipes match “${q}”` : "No recipes yet"}</strong><Link to={`/m/meals/recipes/new${q ? `?title=${encodeURIComponent(q)}` : ""}`}>{q ? `Create “${q}”` : "Add your first recipe"}</Link></div>}
        </div>
        <Button block disabled={!recipe} onClick={add}>{recipe ? `Add ${recipe.title} · ${sv} ${sv === 1 ? "serving" : "servings"}` : "Pick a recipe"}</Button>
      </div>
    </Sheet>
  );
}

function MealSheet({ meal, data, onClose }: { meal: MealRow; data: MealsData; onClose: () => void }) {
  const { today } = useCtx();
  const m = useMutate();
  const recipe = data.recipes.find((r) => r.id === meal.recipe_id);
  const [servings, setServings] = useState(meal.servings);
  const [day, setDay] = useState(meal.date);
  const pastOrToday = meal.date <= today;
  const next = Array.from({ length: 7 }, (_, i) => addDays(pastOrToday ? today : meal.date, i - (pastOrToday ? 0 : 3))).filter((x) => x >= today);
  const save = async () => { await m.put("meals_planned", meal.id, { servings, date: day }); onClose(); };
  return (
    <Sheet title={recipe?.title ?? "Deleted recipe"} onClose={onClose}>
      <div className="h-stack" style={{ gap: 14 }}>
        <span className="muted">{fmt(meal.date, { weekday: "long", day: "numeric", month: "short" })} · {cap(meal.slot)}{meal.bought_on_trip_id ? " · ingredients already bought" : ""}</span>
        <div className="h-row"><span className="h-row__main"><span className="h-row__title">Servings</span>{recipe && <span className="h-row__sub">Recipe makes {recipe.base_servings}</span>}</span><Stepper label="Servings" value={servings} max={50} onChange={setServings} /></div>
        <div className="h-stack"><strong style={{ fontSize: 13 }}>{pastOrToday ? "Didn’t make it? Move it to" : "Day"}</strong>
          <div role="radiogroup" aria-label="Day" className="chips">{next.map((x) => <button key={x} type="button" role="radio" aria-checked={day === x} className="h-chip" onClick={() => setDay(x)}>{fmt(x)}</button>)}</div>
          {meal.bought_on_trip_id && day !== meal.date && <span className="muted" style={{ fontSize: 12 }}>Already bought, so nothing is added to another list for this meal.</span>}
        </div>
        <Button block onClick={save}>{day !== meal.date ? `Move to ${fmt(day)}` : "Save"}</Button>
        <div className="row-actions">
          {recipe && <Link className="h-btn h-btn--text" to={`/m/meals/recipes/${recipe.id}`}>Open recipe</Link>}
          {pastOrToday
            ? <Button variant="text" onClick={async () => { await m.put("meals_planned", meal.id, { status: "skipped" }); onClose(); }}>Skip it</Button>
            : <Button variant="text" className="danger-text" onClick={async () => { await m.put("meals_planned", meal.id, { deleted: 1 }); onClose(); }}>Remove from plan</Button>}
        </div>
      </div>
    </Sheet>
  );
}

export const Skeleton = () => <div className="h-stack" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="h-skeleton" style={{ height: 56 }} />)}</div>;

/** Desktop only: next-trip summary beside the week (canvas › Plan — desktop). */
function NextTripPanel({ data }: { data: MealsData }) {
  const { today, household } = useCtx();
  const next = data.trips.find((t) => t.status !== "finished" && t.date >= today);
  if (!next) return <aside className="plan-panel h-card"><strong>No upcoming grocery run</strong><span className="muted">Tap ‘+ Add run’ above to plan one.</span></aside>;
  const l = listFor(data, next, household.measurement);
  const bySection = new Map<string, number>();
  for (const r of l.rows) if (r.state.kind !== "inCart" && r.state.kind !== "haveIt") { const s = ingredientOf(data, r.line.ingredientId)?.section ?? "other"; bySection.set(s, (bySection.get(s) ?? 0) + 1); }
  const total = l.rows.length + l.extras.length; const got = l.rows.filter((r) => r.state.kind === "inCart").length + l.extras.filter((e) => e.checked).length;
  return (
    <aside className="plan-panel h-card" aria-label="Next grocery run">
      <span className="h-section-title">Next grocery run</span>
      <strong style={{ fontSize: 18 }}>{fmt(next.date)} · {plural(total, "item")}</strong>
      <span className="progress" aria-hidden="true"><span style={{ width: total ? `${(got / total) * 100}%` : 0 }} /></span>
      {[...bySection].map(([k, n]) => <div key={k} className="spread" style={{ fontSize: 14 }}><span>{sectionName(k)}</span><span className="muted">{n} left</span></div>)}
      <Link className="h-btn h-btn--primary" to={`/m/meals/lists/${next.id}`}>Open list</Link>
    </aside>
  );
}
