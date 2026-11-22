import { addDays, buildLines, shoppingWindows } from "@haven/meals-core";
import { Button, Dialog } from "@haven/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "./Plan";
import { useCtx } from "./ctx";
import { amount, fmt, ingredientOf, listFor, mealOf, newId, toRecipe, tripOf, useMealsData, useMutate, type MealsData, type TripRow } from "./data";
import { ModuleShell } from "./shell";

export interface FinalLine { key: string; name: string; qty?: number; unit?: string; base: number; section: string }

export function Lists() {
  const { today, household } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const [moving, setMoving] = useState<TripRow | null>(null);
  if (!d) return <ModuleShell title="Lists" tab="lists"><Skeleton /></ModuleShell>;
  const regular = d.trips.filter((t) => t.kind === "regular");
  const windows = shoppingWindows(regular.map(tripOf));
  const upcoming = d.trips.filter((t) => t.status !== "finished");
  const done = d.trips.filter((t) => t.status === "finished").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const color = (t: TripRow) => (t.kind === "topup" ? 4 : (regular.findIndex((x) => x.id === t.id) % 4) + 1);
  const next = upcoming.find((t) => t.kind === "regular" && t.date >= today);

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
      {!upcoming.length && !added.length && <div className="empty-state"><h2>No upcoming trips</h2><p className="muted">Mark a shopping day on Plan and its list builds itself from the meals it covers.</p><Link className="h-btn h-btn--primary" to="/m/meals/plan">Go to Plan</Link></div>}
      {added.map(({ trip, extra, lines }) => {
        const snapshot = lines.map((l) => ({ key: l.key, name: ingredientOf(d, l.ingredientId)?.name ?? "?", qty: l.shown.qty, unit: l.shown.unit, base: l.base, section: ingredientOf(d, l.ingredientId)?.section ?? "other" }));
        return (
          <section key={trip.id} className="h-card h-stack" style={{ padding: 16, borderColor: "var(--haven-accent-2)" }}>
            <strong>{extra.length} {extra.length === 1 ? "item" : "items"} added since the {fmt(trip.date)} trip</strong>
            <span>{extra.map((x) => `${x.name}${amount(x.shown.qty, x.shown.unit) ? ` · ${amount(x.shown.qty, x.shown.unit)}` : ""}`).join(" · ")}</span>
            {next && <Button onClick={() => carry(trip, next, extra, snapshot)}>Add to {fmt(next.date)} trip</Button>}
            <Button variant="secondary" onClick={async () => { const id = newId(); await m.put("meals_trips", id, { date: today, kind: "topup", status: "upcoming" }); await carry(trip, { id, date: today, kind: "topup", status: "upcoming" } as TripRow, extra, snapshot); }}>Start a top-up trip today</Button>
          </section>
        );
      })}
      {upcoming.map((t) => {
        const w = windows.find((x) => x.tripId === t.id);
        const l = listFor(d, t, household.measurement);
        const total = l.rows.length + l.extras.length;
        const inCart = l.rows.filter((r) => r.state.kind === "inCart").length + l.extras.filter((e) => e.checked).length;
        const overdue = t.date < today;
        return (
          <div key={t.id} className={`trip-card trip-${color(t)}`}>
            <Link to={`/m/meals/lists/${t.id}`} className="trip-card__link">
              <span className="spread"><strong style={{ fontSize: 20 }}>{fmt(t.date, { weekday: "short", month: "short", day: "numeric" })}</strong>
                {overdue ? <span className="h-badge badge--accent2">Overdue</span> : t.kind === "topup" ? <span className="h-badge badge--ink">Top-up</span> : null}</span>
              <span className="trip-card__sub">{t.kind === "topup" ? `${total} items` : w ? `Covers ${fmt(w.from, { weekday: "short" })}–${fmt(w.to, { weekday: "short" })} · ${l.meals.length} meals` : ""}</span>
              <span className="progress" aria-hidden="true"><span style={{ width: total ? `${(inCart / total) * 100}%` : 0 }} /></span>
              <span className="trip-card__sub"><strong>{inCart} of {total} in cart</strong></span>
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
    if (data.trips.some((t) => t.kind === "regular" && t.date === today && t.id !== trip.id)) { onClose(); return; }
    await m.put("meals_trips", trip.id, { date: today, status: "upcoming" });
    if (!drop) for (const l of onlyPast) await m.item(trip.id, `extra_${newId()}`, { label: ingredientOf(data, l.ingredientId)?.name ?? "?", qty: l.shown.qty ?? null, unit: l.shown.unit ?? null, section: ingredientOf(data, l.ingredientId)?.section ?? "other", carried_from: trip.id });
    onClose();
  }
  return (
    <Dialog title={`Move this trip to today, ${fmt(today)}?`} body={onlyPast.length ? `${past.map((p) => data.recipes.find((r) => r.id === p.recipeId)?.title).filter(Boolean).join(", ")} ${past.length === 1 ? "is" : "are"} in the past. These items were only for ${past.length === 1 ? "that meal" : "those meals"}:` : "Meals before today will no longer be on this list."} onClose={onClose}>
      {onlyPast.length > 0 && <ul style={{ margin: 0 }}>{onlyPast.map((l) => <li key={l.key}>{ingredientOf(data, l.ingredientId)?.name} · {amount(l.shown.qty, l.shown.unit)}</li>)}</ul>}
      {onlyPast.length > 0 && <label className="chips"><input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} /> Drop them — I’ll cook those meals another day or skip them</label>}
      <Button onClick={go}>Move trip</Button><Button variant="text" onClick={onClose}>Cancel</Button>
    </Dialog>
  );
}

export const windowEnd = (t: TripRow, d: MealsData) => shoppingWindows(d.trips.filter((x) => x.kind === "regular").map(tripOf)).find((w) => w.tripId === t.id)?.to ?? addDays(t.date, 0);
export { mealOf };
