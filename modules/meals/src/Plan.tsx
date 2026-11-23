import { addDays } from "@haven/meals-core";
import { Button, Sheet, Stepper } from "@haven/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";
import { cap, fmt, newId, SLOTS, useMealsData, useMutate, type MealRow, type MealsData } from "./data";
import { ModuleShell } from "./shell";

/**
 * Plan is about meals (decision, Nov 2026: the shopping list builds itself from
 * what's planned; there is no run to put a meal on any more).
 */
export function Plan() {
  const { today } = useCtx();
  const d = useMealsData();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<MealRow | null>(null);

  // Sliding window (decision, Nov 2026): today and the next six days; arrows move a week at a time.
  const start = addDays(today, 7 * offset);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  if (!d) return <ModuleShell title="Plan" tab="plan"><Skeleton /></ModuleShell>;
  const mealsOn = (day: string) => d.meals.filter((x) => x.date === day && x.status === "planned").sort((a, b) => SLOTS.indexOf(a.slot as never) - SLOTS.indexOf(b.slot as never));
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
          <p className="muted" style={{ margin: 0 }}>Add meals to days. Your shopping list builds itself from what’s planned.</p>
          {d.recipes.length ? <Button onClick={() => setAdding(days.find((x) => x >= today) ?? days[0])}>Add a meal</Button> : <Link className="h-btn h-btn--primary" to="/m/meals/recipes/new">Add your first recipe</Link>}
        </section>
      )}
      <div className="plan-layout"><div className="plan-days">
        {days.map((day) => {
          const meals = mealsOn(day); const past = day < today;
          return (
            <div key={day} className={`day h-card${past ? " day--past" : ""}${day === today ? " day--today" : ""}`}>
              <div className="day__date"><span>{day === today ? "Today" : fmt(day, { weekday: "short" })}</span><strong>{fmt(day, { day: "numeric" })}</strong></div>
              <div className="day__meals">
                {meals.map((x) => (
                  <div key={x.id} className="meal-wrap">
                    <button className="meal" onClick={() => setOpen(x)}>
                      <span className="meal__slot">{cap(x.slot)}</span><span>{d.recipes.find((r) => r.id === x.recipe_id)?.title ?? x.recipe_snapshot?.title ?? "Deleted recipe"}</span>
                    </button>
                  </div>
                ))}
                {!past && <button className="add-meal" onClick={() => setAdding(day)}>+ Add meal</button>}
              </div>
            </div>
          );
        })}
      </div></div>
      {adding && <AddMeal day={adding} data={d} onClose={() => setAdding(null)} />}
      {open && <MealSheet meal={open} data={d} onClose={() => setOpen(null)} />}
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
  const save = async () => {
    await m.put("meals_planned", meal.id, { servings, date: day });
    // Moving the meal or changing servings re-plans it: bought items cleared from the
    // list come back, so the new plan is shopped for.
    if (servings !== meal.servings || day !== meal.date) await m.unClearMeal(data, meal.id);
    onClose();
  };
  return (
    <Sheet title={recipe?.title ?? "Deleted recipe"} onClose={onClose}>
      <div className="h-stack" style={{ gap: 14 }}>
        <span className="muted">{fmt(meal.date, { weekday: "long", day: "numeric", month: "short" })} · {cap(meal.slot)}</span>
        <div className="h-row"><span className="h-row__main"><span className="h-row__title">Servings</span>{recipe && <span className="h-row__sub">Recipe makes {recipe.base_servings}</span>}</span><Stepper label="Servings" value={servings} max={50} onChange={setServings} /></div>
        <div className="h-stack"><strong style={{ fontSize: 13 }}>{pastOrToday ? "Didn’t make it? Move it to" : "Day"}</strong>
          <div role="radiogroup" aria-label="Day" className="chips">{next.map((x) => <button key={x} type="button" role="radio" aria-checked={day === x} className="h-chip" onClick={() => setDay(x)}>{fmt(x)}</button>)}</div>
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
