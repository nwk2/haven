import { addDays } from "@haven/meals-core";
import { Button, Dialog, Icon, Sheet, Stepper } from "@haven/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";
import { progressOf, RunProgress, sectionCount } from "./progress";
import { cap, fmt, ingredientOf, listFor, newId, plural, runColor, runName, sectionName, SLOTS, upcomingRuns, useMealsData, useMutate, type MealRow, type MealsData } from "./data";
import type { TripRow } from "./data";
import { AssignSheet, RunPlanner, RunSheet, undoRun, type RunUndo } from "./runs";
import { ModuleShell } from "./shell";
import { UndoToast } from "./RecipeEditor";

/**
 * Plan (decision, Nov 2026: plan grocery runs from Lists; a run holds the meals you pick).
 * Plan is about meals. Each upcoming meal says which run it's on; tapping that line puts it on a run
 * in place ("No grocery run yet ›" → Add to the Sun 22 run, or a new run).
 */
export function Plan() {
  const { today } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<MealRow | null>(null);
  const [assignFor, setAssignFor] = useState<MealRow | null>(null);
  const [planner, setPlanner] = useState<{ focus?: MealRow } | null>(null);
  const [runSheet, setRunSheet] = useState<TripRow | null>(null);
  const [editRun, setEditRun] = useState<TripRow | null>(null);
  const [undo, setUndo] = useState<RunUndo | null>(null);

  // Sliding window (decision, Nov 2026): today and the next six days; arrows move a week at a time.
  const start = addDays(today, 7 * offset);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  if (!d) return <ModuleShell title="Plan" tab="plan"><Skeleton /></ModuleShell>;
  const mealsOn = (day: string) => d.meals.filter((x) => x.date === day && x.status === "planned").sort((a, b) => SLOTS.indexOf(a.slot as never) - SLOTS.indexOf(b.slot as never));
  const runById = (id?: string | null) => (id ? d.trips.find((t) => t.id === id) : undefined);
  const empty = !d.meals.some((x) => x.status === "planned" && x.date >= start && x.date <= days[6]);

  return (
    <ModuleShell title="Plan" tab="plan" header={
      <div className="week-switch h-card">
        <button className="h-icon-btn" aria-label="Previous 7 days" onClick={() => setOffset(offset - 1)}>‹</button>
        <div className="center-text"><strong>{fmt(days[0], { month: "short", day: "numeric" })} – {fmt(days[6], { month: "short", day: "numeric" })}</strong>
          <div className="muted" style={{ fontSize: 12 }}>{offset === 0 ? "Today onwards" : <button className="linklike" onClick={() => setOffset(0)}>Back to today</button>}</div></div>
        <button className="h-icon-btn" aria-label="Next 7 days" onClick={() => setOffset(offset + 1)}>›</button>
      </div>}>
      {empty && (
        <section className="h-card h-stack" style={{ padding: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Nothing planned for the next 7 days</h2>
          <p className="muted" style={{ margin: 0 }}>Add meals to days. Then plan a grocery run from Lists, or from any meal here.</p>
          {d.recipes.length ? <Button onClick={() => setAdding(days.find((x) => x >= today) ?? days[0])}>Add a meal</Button> : <Link className="h-btn h-btn--primary" to="/m/meals/recipes/new">Add your first recipe</Link>}
        </section>
      )}
      <div className="plan-layout"><div className="plan-days">
        {days.map((day) => {
          const meals = mealsOn(day); const past = day < today;
          const runsToday = upcomingRuns(d).filter((t) => t.date === day);
          return (
            <div key={day} className={`day h-card${past ? " day--past" : ""}${day === today ? " day--today" : ""}`}>
              <div className="day__date"><span>{day === today ? "Today" : fmt(day, { weekday: "short" })}</span><strong>{fmt(day, { day: "numeric" })}</strong></div>
              <div className="day__meals">
                {runsToday.length > 0 && <div className="chips">{runsToday.map((t) => <button key={t.id} className={`run-tag run-tag--${runColor(d, t)}`} onClick={() => setRunSheet(t)}>{t.name ? `Grocery run · ${t.name}` : "Grocery run"}</button>)}</div>}
                {meals.map((x) => {
                  const run = runById(x.run_id);
                  return (
                    <div key={x.id} className="meal-wrap">
                      <button className="meal" onClick={() => setOpen(x)}>
                        <span className="meal__slot">{cap(x.slot)}</span><span>{d.recipes.find((r) => r.id === x.recipe_id)?.title ?? x.recipe_snapshot?.title ?? "Deleted recipe"}</span>
                      </button>
                      {!past && (run
                        ? <button className={`run-status run-status--${runColor(d, run)} run-status--btn`} onClick={() => setAssignFor(x)}><span className={`run-dot run-dot--${runColor(d, run)}`} aria-hidden="true" />On the {runName(d, run)} run</button>
                        : <button className="run-status run-status--none" onClick={() => setAssignFor(x)}><span className="run-dot run-dot--none" aria-hidden="true" />No grocery run yet ›</button>)}
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
      {assignFor && <AssignSheet data={d} meal={assignFor} onUndo={setUndo} onClose={() => setAssignFor(null)} onNewRun={() => { setPlanner({ focus: assignFor }); setAssignFor(null); }} />}
      {planner && <RunPlanner data={d} focus={planner.focus} onUndo={setUndo} onClose={() => setPlanner(null)} />}
      {runSheet && <RunSheet data={d} run={runSheet} onUndo={setUndo} onClose={() => setRunSheet(null)} onEdit={() => { setEditRun(runSheet); setRunSheet(null); }} />}
      {editRun && <RunPlanner data={d} run={editRun} onUndo={setUndo} onClose={() => setEditRun(null)} />}
      {undo && <UndoToast text={undo.text} onUndo={() => { void undoRun(m.put, undo); setUndo(null); }} onDone={() => setUndo(null)} />}
    </ModuleShell>
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
  const next = upcomingRuns(data).find((t) => t.date >= today);
  if (!next) return <aside className="plan-panel h-card"><strong>No upcoming grocery run</strong><span className="muted">Plan one from Lists, or from any meal’s “No grocery run yet”.</span></aside>;
  const l = listFor(data, next, household.measurement);
  // Per section: [left, couldn’t get] — the same split Shopping shows (open rows, not in cart / have it, plus open extras).
  const bySection = new Map<string, [number, number]>();
  const add = (s: string, cannot: boolean) => { const c = bySection.get(s) ?? [0, 0]; if (cannot) c[1]++; else c[0]++; bySection.set(s, c); };
  for (const r of l.rows) if (r.state.kind !== "inCart" && r.state.kind !== "haveIt") add(ingredientOf(data, r.line.ingredientId)?.section ?? "other", r.state.kind === "unavailable");
  for (const e of l.extras) if (!e.checked) add(e.section ?? "other", !!e.unavailable);
  const total = l.rows.length + l.extras.length;
  return (
    <aside className="plan-panel h-card" aria-label="Next grocery run">
      <span className="h-section-title">Next grocery run</span>
      <strong style={{ fontSize: 18 }}>{runName(data, next)} · {plural(total, "item")}</strong>
      <RunProgress p={progressOf(l)} />
      {[...bySection].map(([k, [left, cannot]]) => <div key={k} className="spread" style={{ fontSize: 14 }}><span>{sectionName(k)}</span><span className="muted">{sectionCount(left, cannot)}</span></div>)}
      <Link className="h-btn h-btn--primary" to={`/m/meals/lists/${next.id}`}>Open list</Link>
    </aside>
  );
}
