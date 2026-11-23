import type { ListRow } from "@haven/meals-core";
import { Button, Field, Icon, Select, Sheet } from "@haven/ui";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCtx } from "./ctx";
import { progressOf, RunProgress, sectionCount } from "./progress";
import { amount, fmt, ingredientOf, listFor, nameCase, newId, runColor, runName, upcomingRuns, SECTIONS, sectionName, useMealsData, useMutate, type ItemRow, type MealsData, type TripRow } from "./data";
import type { FinalLine } from "./Lists";

export function Shopping() {
  const { tripId } = useParams();
  const { household, user, sync } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const nav = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  const [sheet, setSheet] = useState<ListRow | null>(null);
  const [extraSheet, setExtraSheet] = useState<ItemRow | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [draft, setDraft] = useState("");
  const [announce, setAnnounce] = useState("");
  const [status, setStatus] = useState(sync.status);
  useEffect(() => sync.subscribe(setStatus) as unknown as () => void, [sync]);

  // Keep the phone awake in the shop (Technical spec › PWA details).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav2 = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav2.wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => undefined);
    return () => { void lock?.release(); };
  }, []);

  const trip = d?.trips.find((t) => t.id === tripId);
  const list = d && trip ? listFor(d, trip, household.measurement) : null;
  // "New" badge for items that appear while the list is open (PRD › Sync and people).
  useEffect(() => {
    if (!list) return;
    const keys = new Set(list.rows.map((r) => r.line.key));
    if (!seen.current) { seen.current = keys; return; }
    const fresh = [...keys].filter((k) => !seen.current!.has(k));
    if (fresh.length) { const t = setTimeout(() => setAnnounce(`${fresh.length} new ${fresh.length === 1 ? "item" : "items"} on the list`), 5000); return () => clearTimeout(t); }
  }, [list]);

  if (!d) return null;
  if (!trip || !list) return <main className="page" style={{ paddingTop: 24 }}><p>This grocery run no longer exists. <Link to="/m/meals/lists">Back to lists</Link></p></main>;
  if (trip.status === "finished") return <FinishedTrip trip={trip} />;

  const sectionOf = (r: ListRow) => ingredientOf(d, r.line.ingredientId)?.section ?? "other";
  const todo = list.rows.filter((r) => r.state.kind === "todo" || r.state.kind === "needsMore" || r.state.kind === "unavailable");
  const total = list.rows.length + list.extras.length;
  const toggle = (r: ListRow) => {
    const checked = r.state.kind === "inCart";
    return m.item(trip.id, r.line.key, checked ? { checked: 0, bought_qty: null } : { checked: 1, checked_by: user.id, checked_at: Date.now(), bought_qty: r.line.base, unavailable: 0 });
  };
  const color = runColor(d, trip);

  return (<>
    <header className={`shop-head trip-${color}`}>
      <div className="spread"><Link to="/m/meals/lists" className="h-icon-btn" aria-label="Back to lists">{Icon.back}</Link>
        <span className="muted" role="status" style={{ fontSize: 12 }}>{status.state === "offline" ? `Offline · ${status.pending} changes waiting` : status.state === "synced" ? "Synced" : "Syncing…"}</span>
        <Button variant="secondary" onClick={() => setFinishing(true)}>Finish run</Button></div>
      <div className="spread" style={{ padding: "0 8px" }}><h1 style={{ margin: 0, fontSize: 24 }}>{runName(d, trip)}</h1></div>
      <div style={{ padding: "0 8px" }}><RunProgress p={progressOf(list)} strong /></div>
    </header>
    <main className="page h-stack" style={{ paddingBottom: 110 }}>
      <div className="h-sr" aria-live="polite">{announce}</div>
      {!total && <div className="empty-state"><h2>Nothing to buy yet</h2><p className="muted">No meals are planned for this trip. Plan some, or add extra items below.</p><Link className="h-btn h-btn--primary" to="/m/meals/plan">Go to Plan</Link></div>}
      {SECTIONS.map(([sec, label]) => {
        const rows = list.rows.filter((r) => sectionOf(r) === sec);
        const extras = list.extras.filter((e) => (e.section ?? "other") === sec);
        const open = rows.filter((r) => r.state.kind !== "inCart" && r.state.kind !== "haveIt");
        const openExtras = extras.filter((e) => !e.checked);
        const cart = rows.filter((r) => r.state.kind === "inCart");
        const cartExtras = extras.filter((e) => e.checked);
        if (!rows.length && !extras.length) return null;
        return (
          <section key={sec} className="h-stack" aria-labelledby={`s-${sec}`}>
            <div className="spread"><h2 id={`s-${sec}`} style={{ margin: 0, fontSize: 15 }}>{label}</h2><span className="muted" style={{ fontSize: 12 }}>{sectionCount(open.filter((r) => r.state.kind !== "unavailable").length + openExtras.filter((e) => !e.unavailable).length, open.filter((r) => r.state.kind === "unavailable").length + openExtras.filter((e) => !!e.unavailable).length)}</span></div>
            {open.map((r) => <ItemLine key={r.line.key} d={d} row={r} isNew={!!seen.current && !seen.current.has(r.line.key)} onToggle={() => toggle(r)} onMore={() => setSheet(r)} />)}
            {openExtras.map((e) => <ExtraLine key={e.id} item={e} onToggle={() => m.item(trip.id, e.key, { checked: 1, checked_by: user.id, checked_at: Date.now() })} onMore={() => setExtraSheet(e)} />)}
            {cart.length + cartExtras.length > 0 && <span className="h-section-title" style={{ fontSize: 11 }}>In cart · {cart.length + cartExtras.length}</span>}
            {cart.map((r) => <ItemLine key={r.line.key} d={d} row={r} done onToggle={() => toggle(r)} onMore={() => setSheet(r)} />)}
            {cartExtras.map((e) => <ExtraLine key={e.id} item={e} done onToggle={() => m.item(trip.id, e.key, { checked: 0 })} onMore={() => setExtraSheet(e)} />)}
          </section>
        );
      })}
      {list.noLongerNeeded.length > 0 && <section className="h-stack"><span className="h-section-title">Bought, no longer needed · {list.noLongerNeeded.length}</span>
        {list.noLongerNeeded.map((s) => <div key={s.key} className="h-row done-row"><span className="h-row__main" style={{ textDecoration: "line-through" }}>{ingredientOf(d, s.key.split("_")[0])?.name ?? s.key}</span></div>)}</section>}
      {list.rows.some((r) => r.state.kind === "haveIt") && <details className="have-it"><summary>Have it · {list.rows.filter((r) => r.state.kind === "haveIt").length} hidden</summary>
        {list.rows.filter((r) => r.state.kind === "haveIt").map((r) => <button key={r.line.key} className="h-row" style={{ width: "100%" }} onClick={() => m.item(trip.id, r.line.key, { have_it: 0 })}>{ingredientOf(d, r.line.ingredientId)?.name} · Undo</button>)}</details>}
    </main>
    <form className="add-bar" onSubmit={async (e) => { e.preventDefault(); if (!draft.trim()) return; await m.item(trip.id, `extra_${newId()}`, { label: nameCase(draft), section: "other" }); setDraft(""); }}>
      <label className="h-sr" htmlFor="extra">Add an extra item</label>
      <input id="extra" className="h-input" placeholder="Add an extra item, e.g. paper towels" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <Button type="submit">Add</Button>
    </form>
    {sheet && <ItemSheet d={d} trip={trip} row={sheet} onClose={() => setSheet(null)} />}
    {extraSheet && <ExtraSheet trip={trip} item={extraSheet} onClose={() => setExtraSheet(null)} />}
    {finishing && <FinishTrip d={d} trip={trip} todo={todo} extras={list.extras.filter((e) => !e.checked)} onClose={() => setFinishing(false)} onDone={() => nav("/m/meals/lists")} />}
  </>);
}

function ItemLine({ d, row, done, isNew, onToggle, onMore }: { d: MealsData; row: ListRow; done?: boolean; isNew?: boolean; onToggle: () => void; onMore: () => void }) {
  const name = ingredientOf(d, row.line.ingredientId)?.name ?? "?";
  const qty = amount(row.line.shown.qty, row.line.shown.unit);
  const recipes = [...new Set(row.line.sources.map((s) => d.recipes.find((r) => r.id === s.recipeId)?.title).filter(Boolean))].join(" · ");
  const st = row.state;
  return (
    <div className="item">
      <button className={`h-row item__main${done ? " item--done" : ""}`} aria-pressed={!!done} onClick={onToggle}
        aria-label={`${name}${qty ? `, ${qty}` : ""}${recipes ? `, for ${recipes}` : ""}, ${done ? "in cart" : "not checked"}`}>
        <span className={`check${done ? " check--on" : ""}`} aria-hidden="true">{done && Icon.check}</span>
        <span className="h-row__main"><span className="h-row__title">{name}{st.kind === "needsMore" ? <span className="muted"> · {amount(st.more.qty, st.more.unit)} more</span> : qty ? <span className="muted"> · {qty}</span> : null}</span>
          {!done && <span className="h-row__sub">{recipes}</span>}</span>
        {isNew && <span className="h-badge badge--accent">New</span>}
        {st.kind === "needsMore" && <span className="h-badge badge--accent2">+{amount(st.more.qty, st.more.unit)}</span>}
        {st.kind === "unavailable" && <span className="h-badge badge--danger">Couldn’t get</span>}
      </button>
      <button className="h-icon-btn" aria-label={`More for ${name}`} onClick={onMore}>{Icon.more}</button>
    </div>
  );
}

function ExtraLine({ item, done, onToggle, onMore }: { item: ItemRow; done?: boolean; onToggle: () => void; onMore: () => void }) {
  return (
    <div className="item">
      <button className={`h-row item__main${done ? " item--done" : ""}`} aria-pressed={!!done} onClick={onToggle}>
        <span className={`check${done ? " check--on" : ""}`} aria-hidden="true">{done && Icon.check}</span>
        <span className="h-row__main"><span className="h-row__title">{item.label}{item.qty ? <span className="muted"> · {amount(item.qty, item.unit)}</span> : null}</span>{!done && <span className="h-row__sub">{item.carried_from ? "Carried from an earlier run" : "Extra"}</span>}</span>
        {item.carried_from && !done && <span className="h-badge badge--neutral">Carried</span>}
        {!!item.unavailable && !done && <span className="h-badge badge--danger">Couldn’t get</span>}
      </button>
      <button className="h-icon-btn" aria-label={`More for ${item.label}`} onClick={onMore}>{Icon.more}</button>
    </div>
  );
}

function ItemSheet({ d, trip, row, onClose }: { d: MealsData; trip: TripRow; row: ListRow; onClose: () => void }) {
  const m = useMutate();
  const ing = ingredientOf(d, row.line.ingredientId);
  const per = row.line.sources.map((s) => {
    const meal = d.meals.find((x) => x.id === s.mealId); const r = d.recipes.find((x) => x.id === s.recipeId);
    const orig = r?.ingredients.find((l) => ingredientOf(d, l.ingredientId)?.id === ing?.id);
    const scaled = orig?.qty != null && meal && r ? orig.qty * (meal.servings / r.base_servings) : undefined;
    return { id: s.mealId, title: r?.title ?? "Deleted recipe", when: meal ? `${fmt(meal.date)} · ${meal.slot}` : "", qty: amount(scaled, orig?.unit) };
  });
  return (
    <Sheet title={`${ing?.name ?? "?"}${amount(row.line.shown.qty, row.line.shown.unit) ? ` · ${amount(row.line.shown.qty, row.line.shown.unit)}` : ""}`} onClose={onClose}>
      <div className="h-stack">
        <span className="muted" style={{ fontSize: 12 }}>{sectionName(ing?.section ?? "other")}</span>
        <strong style={{ fontSize: 13 }}>Needed for</strong>
        {per.map((p) => <Link key={p.id} className="h-row" to={`/m/meals/recipes/${d.meals.find((x) => x.id === p.id)?.recipe_id}`}><span className="h-row__main"><span className="h-row__title">{p.title}</span><span className="h-row__sub">{p.when}</span></span><strong>{p.qty}</strong></Link>)}
        <Button variant="secondary" block onClick={async () => { await m.item(trip.id, row.line.key, { have_it: 1, checked: 0 }); onClose(); }}>Have it — skip for this run</Button>
        <Button variant="secondary" block onClick={async () => { await m.item(trip.id, row.line.key, { unavailable: row.state.kind === "unavailable" ? 0 : 1, checked: 0 }); onClose(); }}>{row.state.kind === "unavailable" ? "Found it after all" : "Couldn’t get it"}</Button>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Amounts come from recipes. To change them, edit the recipe or the meal’s servings.</p>
      </div>
    </Sheet>
  );
}

function ExtraSheet({ trip, item, onClose }: { trip: TripRow; item: ItemRow; onClose: () => void }) {
  const m = useMutate();
  const [label, setLabel] = useState(item.label ?? ""); const [qty, setQty] = useState(item.qty != null ? String(item.qty) : ""); const [unit, setUnit] = useState(item.unit ?? ""); const [section, setSection] = useState(item.section ?? "other");
  return (
    <Sheet title={item.label ?? "Extra item"} onClose={onClose}>
      <div className="h-stack">
        <Field label="Name" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="two-col"><Field label="Amount" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /><Field label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <label className="h-field"><span className="h-field__label">Store section</span><Select value={section} onChange={(e) => setSection(e.target.value)}>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
        <Button block onClick={async () => { await m.item(trip.id, item.key, { label: label.trim() || item.label, qty: qty ? Number(qty.replace(",", ".")) : null, unit: unit || null, section }); onClose(); }}>Save</Button>
        <Button variant="secondary" block onClick={async () => { await m.item(trip.id, item.key, { unavailable: item.unavailable ? 0 : 1 }); onClose(); }}>{item.unavailable ? "Found it after all" : "Couldn’t get it"}</Button>
        <Button variant="text" className="danger-text" onClick={async () => { await m.item(trip.id, item.key, { deleted: 1 }); onClose(); }}>Delete item</Button>
      </div>
    </Sheet>
  );
}

function FinishTrip({ d, trip, todo, extras, onClose, onDone }: { d: MealsData; trip: TripRow; todo: ListRow[]; extras: ItemRow[]; onClose: () => void; onDone: () => void }) {
  const { household, today, user } = useCtx();
  const m = useMutate();
  // Next run to carry unbought items to: any later run, including another one on the same day.
  const next = upcomingRuns(d).find((t) => t.id !== trip.id && t.date >= trip.date);
  const [choice, setChoice] = useState<"move" | "drop">(next ? "move" : "drop");
  const left = todo.length + extras.length;
  async function finish() {
    const l = listFor(d, trip, household.measurement);
    const snapshot: FinalLine[] = l.rows.filter((r) => r.state.kind === "inCart").map((r) => ({ key: r.line.key, name: ingredientOf(d, r.line.ingredientId)?.name ?? "?", qty: r.line.shown.qty, unit: r.line.shown.unit, base: r.line.base, section: ingredientOf(d, r.line.ingredientId)?.section ?? "other" }));
    if (choice === "move" && next) {
      for (const r of todo) await m.item(next.id, `extra_${newId()}`, { label: ingredientOf(d, r.line.ingredientId)?.name ?? "?", qty: r.line.shown.qty ?? null, unit: r.line.shown.unit ?? null, section: ingredientOf(d, r.line.ingredientId)?.section ?? "other", carried_from: trip.id });
      for (const e of extras) await m.item(next.id, `extra_${newId()}`, { label: e.label, qty: e.qty ?? null, unit: e.unit ?? null, section: e.section ?? "other", carried_from: trip.id });
    }
    // Meals in this trip are now bought (PRD › Meals that didn't happen).
    for (const meal of l.meals) await m.put("meals_planned", meal.id, { bought_on_trip_id: trip.id });
    await m.put("meals_trips", trip.id, { status: "finished", finished_at: Date.now(), reopen_until: Date.now() + 86_400_000, final_lines: [...snapshot, ...todo.filter(() => choice === "drop").map((r) => ({ key: r.line.key, name: ingredientOf(d, r.line.ingredientId)?.name ?? "?", base: r.line.base, section: "other" }))] });
    await m.activity(`${user.name.split(" ")[0]} finished the ${fmt(trip.date)} grocery run`);
    onDone();
  }
  return (
    <Sheet title={`Finish the ${fmt(trip.date)} grocery run?`} onClose={onClose}>
      <div className="h-stack">
        <span className="muted">{left ? `${left} ${left === 1 ? "item is" : "items are"} still unchecked.` : "Everything is in the cart."}</span>
        {left > 0 && <ul className="plain h-card" style={{ padding: "4px 12px" }}>{todo.map((r) => <li key={r.line.key} className="ing-line">{ingredientOf(d, r.line.ingredientId)?.name} <span className="muted">{amount(r.line.shown.qty, r.line.shown.unit)}</span></li>)}{extras.map((e) => <li key={e.id} className="ing-line">{e.label} <span className="muted">Extra</span></li>)}</ul>}
        {left > 0 && <div role="radiogroup" aria-label="Unchecked items" className="h-stack">
          <button role="radio" aria-checked={choice === "move"} disabled={!next} className="h-row pick" onClick={() => setChoice("move")}><span className="h-row__main"><span className="h-row__title">{next ? `Move ${left} to the ${runName(d, next)} run` : "No later run yet"}</span><span className="h-row__sub">{next ? "They appear on that list as carried items" : "Plan another grocery run to carry items over"}</span></span></button>
          <button role="radio" aria-checked={choice === "drop"} className="h-row pick" onClick={() => setChoice("drop")}><span className="h-row__main"><span className="h-row__title">Don’t need them</span><span className="h-row__sub">Clear them; the meals stay planned</span></span></button>
        </div>}
        <Button block onClick={finish}>Finish run</Button>
        <Button variant="text" onClick={onClose}>Keep shopping</Button>
        {trip.date > today && <span className="muted" style={{ fontSize: 12 }}>This run is dated {fmt(trip.date)}; finishing early is fine.</span>}
      </div>
    </Sheet>
  );
}

function FinishedTrip({ trip }: { trip: TripRow }) {
  const m = useMutate();
  const lines = (trip.final_lines as FinalLine[] | undefined) ?? [];
  const canReopen = (trip.reopen_until ?? 0) > Date.now();
  return (<>
    <header className="h-header"><Link to="/m/meals/lists" className="h-icon-btn" aria-label="Back to lists">{Icon.back}</Link><h1 className="h-header__title">{fmt(trip.date, { weekday: "short", month: "short", day: "numeric" })} · Done</h1>
      {canReopen && <Button variant="secondary" onClick={() => m.put("meals_trips", trip.id, { status: "upcoming", finished_at: null })}>Reopen</Button>}</header>
    <main className="page h-stack"><ul className="plain">{lines.map((l) => <li key={l.key} className="ing-line">{l.name} <span className="muted">{amount(l.qty, l.unit)}</span></li>)}</ul></main>
  </>);
}
