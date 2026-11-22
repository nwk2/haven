import { addDays, shoppingWindows } from "@haven/meals-core";
import { Button, Dialog, Icon, Sheet, Stepper } from "@haven/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";
import { cap, fmt, ingredientOf, listFor, newId, plural, sectionName, SLOTS, tripOf, useMealsData, useMutate, weekStart, type MealRow, type MealsData, type TripRow } from "./data";
import { ModuleShell } from "./shell";

type Group = { key: string; trip?: TripRow; color: number; days: string[] };

export function Plan() {
  const { household, today } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<MealRow | null>(null);
  const [confirm, setConfirm] = useState<TripRow | null>(null);

  const start = addDays(weekStart(today, household.week_start), 7 * offset);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  if (!d) return <ModuleShell title="Plan" tab="plan"><Skeleton /></ModuleShell>;
  const regular = d.trips.filter((t) => t.kind === "regular");
  const windows = shoppingWindows(regular.map(tripOf));
  const colorOf = (id: string) => regular.findIndex((t) => t.id === id) % 4;
  const groups: Group[] = [];
  for (const day of days) {
    const w = windows.find((x) => day >= x.from && day <= x.to);
    const key = w?.tripId ?? "none";
    const last = groups[groups.length - 1];
    if (last?.key === key) last.days.push(day);
    else groups.push({ key, trip: w ? d.trips.find((t) => t.id === w.tripId) : undefined, color: w ? colorOf(w.tripId) : -1, days: [day] });
  }
  const mealsOn = (day: string) => d.meals.filter((x) => x.date === day && x.status === "planned").sort((a, b) => SLOTS.indexOf(a.slot as never) - SLOTS.indexOf(b.slot as never));
  const tripOn = (day: string) => regular.find((t) => t.date === day);
  const empty = !d.meals.some((x) => x.status === "planned" && x.date >= start && x.date <= days[6]);

  async function toggleShop(day: string) {
    const t = tripOn(day);
    if (!t) { await m.put("meals_trips", newId(), { date: day, kind: "regular", status: "upcoming" }); return; }
    if (d!.items.some((i) => i.trip_id === t.id && i.checked)) { setConfirm(t); return; }
    await m.put("meals_trips", t.id, { deleted: 1 });
  }

  return (
    <ModuleShell title="Plan" tab="plan" header={
      <div className="week-switch h-card">
        <button className="h-icon-btn" aria-label="Previous week" onClick={() => setOffset(offset - 1)}>‹</button>
        <div className="center-text"><strong>{fmt(days[0], { month: "short", day: "numeric" })} – {fmt(days[6], { month: "short", day: "numeric" })}</strong>
          <div className="muted" style={{ fontSize: 12 }}>{offset === 0 ? "This week · tap a cart to set a shopping day" : <button className="linklike" onClick={() => setOffset(0)}>Back to this week</button>}</div></div>
        <button className="h-icon-btn" aria-label="Next week" onClick={() => setOffset(offset + 1)}>›</button>
      </div>}>
      {empty && (
        <section className="h-card h-stack" style={{ padding: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Nothing planned this week</h2>
          <p className="muted" style={{ margin: 0 }}>Add meals to days, then tap a day’s cart to shop for them.</p>
          {d.recipes.length ? <Button onClick={() => setAdding(days.find((x) => x >= today) ?? days[0])}>Add a meal</Button> : <Link className="h-btn h-btn--primary" to="/m/meals/recipes/new">Add your first recipe</Link>}
        </section>
      )}
      <div className="plan-layout"><div className="plan-groups">
      {groups.map((g) => {
        const upcomingMeals = g.days.filter((x) => x >= today).flatMap(mealsOn);
        const isNone = g.key === "none";
        return (
          <section key={g.key + g.days[0]} style={{ "--n": g.days.length } as React.CSSProperties} className={`trip-group ${isNone ? (upcomingMeals.length ? "trip-none" : "trip-plain") : `trip-${g.color + 1}`}`}>
            {!isNone && g.trip && <div className="trip-group__head"><strong>Shop {fmt(g.trip.date)}</strong><span>{plural(g.days.flatMap(mealsOn).length, "meal")}</span></div>}
            {isNone && upcomingMeals.length > 0 && (
              <div className="trip-group__head"><strong>Not on a list · {upcomingMeals.length} {upcomingMeals.length === 1 ? "meal" : "meals"}</strong>
                <Button variant="secondary" onClick={() => toggleShop(g.days.find((x) => x >= today && mealsOn(x).length) ?? today)}>{g.days.includes(today) ? "Shop today" : `Shop on ${fmt(g.days.find((x) => mealsOn(x).length)!)}`}</Button></div>
            )}
            {g.days.map((day) => {
              const meals = mealsOn(day); const shop = !!tripOn(day); const past = day < today;
              return (
                <div key={day} className={`day h-card${past ? " day--past" : ""}${day === today ? " day--today" : ""}`}>
                  <div className="day__date"><span>{day === today ? "Today" : fmt(day, { weekday: "short" })}</span><strong>{fmt(day, { day: "numeric" })}</strong></div>
                  <div className="day__meals">
                    {meals.map((x) => (
                      <button key={x.id} className="meal" onClick={() => setOpen(x)}>
                        <span className="meal__slot">{cap(x.slot)}</span><span>{d.recipes.find((r) => r.id === x.recipe_id)?.title ?? "Deleted recipe"}</span>
                      </button>
                    ))}
                    {!past && <button className="add-meal" onClick={() => setAdding(day)}>+ Add meal</button>}
                  </div>
                  {(!past || shop) && <button className={`cart${shop ? " cart--on" : ""}`} aria-pressed={shop} aria-label={`${shop ? "Remove shopping day" : "Make shopping day"} ${fmt(day, { weekday: "long", day: "numeric" })}`} onClick={() => toggleShop(day)}>{Icon.cart}</button>}
                </div>
              );
            })}
          </section>
        );
      })}
      </div><NextTripPanel data={d} /></div>
      {adding && <AddMeal day={adding} data={d} onClose={() => setAdding(null)} />}
      {open && <MealSheet meal={open} data={d} onClose={() => setOpen(null)} />}
      {confirm && (
        <Dialog title={`Remove ${fmt(confirm.date)} as a shopping day?`} body="Some items on its list are already bought and stay recorded. Unbought items move to the previous trip." onClose={() => setConfirm(null)}>
          <Button variant="danger" onClick={async () => { await m.put("meals_trips", confirm.id, { deleted: 1 }); setConfirm(null); }}>Remove shopping day</Button>
          <Button variant="text" onClick={() => setConfirm(null)}>Cancel</Button>
        </Dialog>
      )}
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
  const next = data.trips.find((t) => t.status !== "finished" && t.date >= today);
  if (!next) return <aside className="plan-panel h-card"><strong>No upcoming trip</strong><span className="muted">Tap a day’s cart to make it a shopping day.</span></aside>;
  const l = listFor(data, next, household.measurement);
  const bySection = new Map<string, number>();
  for (const r of l.rows) if (r.state.kind !== "inCart" && r.state.kind !== "haveIt") { const s = ingredientOf(data, r.line.ingredientId)?.section ?? "other"; bySection.set(s, (bySection.get(s) ?? 0) + 1); }
  const total = l.rows.length + l.extras.length; const got = l.rows.filter((r) => r.state.kind === "inCart").length + l.extras.filter((e) => e.checked).length;
  return (
    <aside className="plan-panel h-card" aria-label="Next trip">
      <span className="h-section-title">Next trip</span>
      <strong style={{ fontSize: 18 }}>{fmt(next.date)} · {plural(total, "item")}</strong>
      <span className="progress" aria-hidden="true"><span style={{ width: total ? `${(got / total) * 100}%` : 0 }} /></span>
      {[...bySection].map(([k, n]) => <div key={k} className="spread" style={{ fontSize: 14 }}><span>{sectionName(k)}</span><span className="muted">{n} left</span></div>)}
      <Link className="h-btn h-btn--primary" to={`/m/meals/lists/${next.id}`}>Open list</Link>
    </aside>
  );
}
