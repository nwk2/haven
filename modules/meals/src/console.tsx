import { addDays } from "@haven/meals-core";
import { Link } from "react-router-dom";
import { Ctx, useCtx, type ModuleCtx } from "./ctx";
import { cap, fmt, plural, shoppingList, SLOTS, useMealsData, type MealRow, type MealsData } from "./data";
import { progressOf } from "./progress";

/**
 * What Meals puts on the household console: today's meal and the shopping list,
 * as content rather than a navigation tile. Mounted by the shell with the same ctx as the module.
 */
export function ConsoleMeals({ ctx }: { ctx: ModuleCtx }) {
  return <Ctx.Provider value={ctx}><Sections /></Ctx.Provider>;
}

const bySlot = (a: MealRow, b: MealRow) => SLOTS.indexOf(a.slot as never) - SLOTS.indexOf(b.slot as never);

function Sections() {
  const { today, household } = useCtx();
  const d = useMealsData();
  if (!d) return null;
  const planned = d.meals.filter((m) => m.status === "planned").sort((a, b) => a.date.localeCompare(b.date) || bySlot(a, b));
  // Nothing planned and no recipes: the console's "Get started" card covers it.
  if (!planned.length && !d.recipes.length) return null;

  const todays = planned.filter((m) => m.date === today);
  const lead = todays.find((m) => m.slot === "dinner") ?? todays[0];
  const next = planned.find((m) => m.date > today);
  const list = shoppingList(d, today, household.measurement);
  const p = progressOf(list);

  return (<>
    <section aria-labelledby="c-meal">
      <div className="c-label"><h2 id="c-meal">{lead?.slot === "dinner" ? "Tonight" : "Today"}</h2><Link to="/m/meals/plan">Plan</Link></div>
      <Link to="/m/meals/plan" className="h-card c-meal">
        {lead
          ? <><span className="c-meal__title">{titleOf(d, lead)}</span><span className="c-meal__sub">{cap(lead.slot)} · {plural(lead.servings, "serving")}</span></>
          : <span className="c-meal__none">Nothing planned today</span>}
        {next && <span className="c-meal__next"><span>{next.date === addDays(today, 1) ? "Tomorrow" : fmt(next.date, { weekday: "long" })} {next.slot}</span><strong>{titleOf(d, next)}</strong></span>}
      </Link>
    </section>

    {p.total > 0 && (
      <section aria-labelledby="c-shop">
        <div className="c-label"><h2 id="c-shop">Shopping</h2><Link to="/m/meals/lists">Open list</Link></div>
        <Link to="/m/meals/lists" className="h-card c-shop">
          <span className="spread">
            <span>{p.left ? <><strong className="tnum">{p.left}</strong> to buy</> : <strong>All done</strong>}</span>
            <span className="c-shop__meta">{[p.inCart && `${p.inCart} bought`, p.have && `${p.have} have it`].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="seg-bar" aria-hidden="true">
            <span className="seg seg--cart" style={{ width: `${(p.inCart / p.total) * 100}%` }} />
            <span className="seg seg--have" style={{ width: `${(p.have / p.total) * 100}%` }} />
            <span className="seg seg--cannot" style={{ width: `${(p.cannot / p.total) * 100}%` }} />
          </span>
        </Link>
      </section>
    )}
  </>);
}

const titleOf = (d: MealsData, m: MealRow) => d.recipes.find((r) => r.id === m.recipe_id)?.title ?? m.recipe_snapshot?.title ?? "Deleted recipe";
