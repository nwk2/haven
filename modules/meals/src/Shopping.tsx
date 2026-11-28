import type { ListRow } from "@haven/meals-core";
import { itemId } from "@haven/sync";
import { Button, Field, Icon, Select, Sheet } from "@haven/ui";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";
import { ListProgress, progressOf, sectionCount } from "./progress";
import { amount, fmt, ingredientOf, mealSubtext, nameCase, newId, sectionName, shoppingList, useMealsData, useMutate, SECTIONS, type MealsData, type StateRow } from "./data";
import { UndoToast } from "./RecipeEditor";
import { ModuleShell } from "./shell";

/**
 * The one shopping list (decision, Nov 2026): everything still to buy for the upcoming
 * planned meals, plus ad-hoc extras — one list, bought over as many store visits as it
 * takes. No runs, no assignment, no dates on the list itself.
 */
export function Shopping() {
  const { household, user, sync, today } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const seen = useRef<Set<string> | null>(null);
  const [sheet, setSheet] = useState<ListRow | null>(null);
  const [extraSheet, setExtraSheet] = useState<StateRow | null>(null);
  const [draft, setDraft] = useState("");
  const [announce, setAnnounce] = useState("");
  const [clearedUndo, setClearedUndo] = useState<{ text: string; states: string[]; extras: string[] } | null>(null);
  const [status, setStatus] = useState(sync.status);
  useEffect(() => sync.subscribe(setStatus) as unknown as () => void, [sync]);

  // Keep the phone awake in the shop (Technical spec › PWA details).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav2 = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav2.wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => undefined);
    return () => { void lock?.release(); };
  }, []);

  const list = d ? shoppingList(d, today, household.measurement) : null;
  // "New" badge for items that appear while the list is open (PRD › Sync and people).
  useEffect(() => {
    if (!list) return;
    const keys = new Set(list.rows.map((r) => r.line.key));
    if (!seen.current) { seen.current = keys; return; }
    const fresh = [...keys].filter((k) => !seen.current!.has(k));
    if (fresh.length) { const t = setTimeout(() => setAnnounce(`${fresh.length} new ${fresh.length === 1 ? "item" : "items"} on the list`), 5000); return () => clearTimeout(t); }
  }, [list]);

  if (!d || !list) return <ModuleShell title="Shopping" tab="shopping"><p className="muted">Loading…</p></ModuleShell>;

  const sectionOf = (r: ListRow) => ingredientOf(d, r.line.ingredientId)?.section ?? "other";
  const total = list.rows.length + list.extras.length;
  const boughtRows = list.rows.filter((r) => r.state.kind === "inCart");
  const boughtExtras = list.extras.filter((e) => e.checked);
  const haveItRows = list.rows.filter((r) => r.state.kind === "haveIt");

  /** Tap to check off: bought for every meal the line covers (each meal's share). */
  const toggle = async (r: ListRow) => {
    const toCart = r.state.kind !== "inCart";
    for (const s of r.line.sources) {
      const st = d.states.find((x) => x.meal_id === s.mealId && x.key === r.line.key);
      if (st?.haveIt || st?.cleared) continue;
      await m.mealState(s.mealId, r.line.key, toCart
        ? { checked: 1, checked_by: user.id, checked_at: Date.now(), bought_qty: s.base }
        : { checked: 0, bought_qty: null });
    }
  };

  /** Clear bought: bought meal items hide until their meal is re-planned; extras are removed. Undoable. */
  async function clearBought() {
    const states: string[] = []; const extras: string[] = [];
    for (const r of boughtRows) for (const s of r.line.sources) { await m.mealState(s.mealId, r.line.key, { cleared: 1 }); states.push(itemId(s.mealId, r.line.key)); }
    for (const e of boughtExtras) { await m.state(e.id, { deleted: 1 }); extras.push(e.id); }
    setClearedUndo({ text: "Bought list cleared.", states, extras });
  }
  async function undoClear() {
    if (!clearedUndo) return;
    for (const id of clearedUndo.states) await m.state(id, { cleared: 0 });
    for (const id of clearedUndo.extras) await m.state(id, { deleted: 0 });
    setClearedUndo(null);
  }

  return (
    <ModuleShell title="Shopping" tab="shopping">
      <div className="h-sr" aria-live="polite">{announce}</div>
      <ListProgress p={progressOf(list)} strong />
      {/* Only say something when it isn't simply up to date. */}
      <span className="muted shop-status" role="status">{status.state === "offline" ? `Offline · ${status.pending} changes waiting` : status.state === "synced" ? "" : "Syncing…"}</span>
      {!total && <div className="empty-state"><h2>Nothing to buy yet</h2><p className="muted">No meals are planned. Plan some, or add extra items below.</p><Link className="h-btn h-btn--primary" to="/m/meals/plan">Go to Plan</Link></div>}
      {SECTIONS.map(([sec, label]) => {
        const rows = list.rows.filter((r) => sectionOf(r) === sec && r.state.kind !== "inCart" && r.state.kind !== "haveIt");
        const extras = list.extras.filter((e) => !e.checked && (e.section ?? "other") === sec);
        if (!rows.length && !extras.length) return null;
        return (
          <section key={sec} className="h-stack" aria-labelledby={`s-${sec}`}>
            <div className="spread"><h2 id={`s-${sec}`} className="shop-sec">{label}</h2><span className="shop-sec__count">{sectionCount(rows.length + extras.length, 0)}</span></div>
            <div className="h-card h-group">{rows.map((r) => <ItemLine key={r.line.key} d={d} row={r} isNew={!!seen.current && !seen.current.has(r.line.key)} onToggle={() => toggle(r)} onMore={() => setSheet(r)} />)}
            {extras.map((e) => <ExtraLine key={e.id} item={e} onToggle={() => m.state(e.id, { checked: 1, checked_by: user.id, checked_at: Date.now() })} onMore={() => setExtraSheet(e)} />)}</div>
          </section>
        );
      })}
      {boughtRows.length + boughtExtras.length > 0 && <section className="h-stack" aria-labelledby="s-bought">
        <div className="spread"><h2 id="s-bought" className="shop-sec">Bought · {boughtRows.length + boughtExtras.length}</h2>
          <button className="h-link" onClick={clearBought}>Clear bought</button></div>
        <div className="h-card h-group">{boughtRows.map((r) => <ItemLine key={r.line.key} d={d} row={r} done onToggle={() => toggle(r)} onMore={() => setSheet(r)} />)}
        {boughtExtras.map((e) => <ExtraLine key={e.id} item={e} done onToggle={() => m.state(e.id, { checked: 0 })} onMore={() => setExtraSheet(e)} />)}</div>
      </section>}
      {haveItRows.length > 0 && <details className="have-it"><summary>Have it · {haveItRows.length} hidden</summary>
        {haveItRows.map((r) => <button key={r.line.key} className="h-row" style={{ width: "100%" }} onClick={async () => { for (const s of r.line.sources) await m.mealState(s.mealId, r.line.key, { have_it: 0 }); }}>{ingredientOf(d, r.line.ingredientId)?.name} · Undo</button>)}</details>}
      <form onSubmit={async (e) => { e.preventDefault(); if (!draft.trim()) return; const id = `extra_${newId()}`; await m.state(id, { meal_id: null, key: id, label: nameCase(draft), section: "other" }); setDraft(""); }}>
        <label className="h-sr" htmlFor="extra">Add an extra item</label>
        <div style={{ display: "flex", gap: 8 }}><input id="extra" className="h-input" style={{ flex: 1 }} placeholder="Extra item, e.g. foil" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button type="submit">Add</Button></div>
      </form>
      {sheet && <ItemSheet d={d} row={sheet} onClose={() => setSheet(null)} />}
      {extraSheet && <ExtraSheet item={extraSheet} onClose={() => setExtraSheet(null)} />}
      {clearedUndo && <UndoToast text={clearedUndo.text} onUndo={() => { void undoClear(); }} onDone={() => setClearedUndo(null)} />}
    </ModuleShell>
  );
}

function ItemLine({ d, row, done, isNew, onToggle, onMore }: { d: MealsData; row: ListRow; done?: boolean; isNew?: boolean; onToggle: () => void; onMore: () => void }) {
  const name = ingredientOf(d, row.line.ingredientId)?.name ?? "?";
  const qty = amount(row.line.shown.qty, row.line.shown.unit);
  const sub = mealSubtext(d, row);
  const st = row.state;
  return (
    <div className="item">
      <button className={`h-row item__main${done ? " item--done" : ""}`} aria-pressed={!!done} onClick={onToggle}
        aria-label={`${name}${qty ? `, ${qty}` : ""}${sub ? `, for ${sub}` : ""}, ${done ? "bought" : "not checked"}`}>
        <span className={`check${done ? " check--on" : ""}`} aria-hidden="true">{done && Icon.check}</span>
        <span className="h-row__main"><span className="h-row__title">{name}{st.kind === "needsMore" ? <span className="muted"> · {amount(st.more.qty, st.more.unit)} more</span> : qty ? <span className="muted"> · {qty}</span> : null}</span>
          {!done && <span className="h-row__sub">{sub}</span>}</span>
        {isNew && <span className="h-badge badge--accent">New</span>}
        {st.kind === "needsMore" && <span className="h-badge badge--accent2">+{amount(st.more.qty, st.more.unit)}</span>}
      </button>
      <button className="h-icon-btn" aria-label={`More for ${name}`} onClick={onMore}>{Icon.more}</button>
    </div>
  );
}

function ExtraLine({ item, done, onToggle, onMore }: { item: StateRow; done?: boolean; onToggle: () => void; onMore: () => void }) {
  return (
    <div className="item">
      <button className={`h-row item__main${done ? " item--done" : ""}`} aria-pressed={!!done} onClick={onToggle}>
        <span className={`check${done ? " check--on" : ""}`} aria-hidden="true">{done && Icon.check}</span>
        <span className="h-row__main"><span className="h-row__title">{item.label}{item.qty ? <span className="muted"> · {amount(item.qty, item.unit)}</span> : null}</span>{!done && <span className="h-row__sub">Extra</span>}</span>
      </button>
      <button className="h-icon-btn" aria-label={`More for ${item.label}`} onClick={onMore}>{Icon.more}</button>
    </div>
  );
}

function ItemSheet({ d, row, onClose }: { d: MealsData; row: ListRow; onClose: () => void }) {
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
        <Button variant="secondary" block onClick={async () => { for (const s of row.line.sources) await m.mealState(s.mealId, row.line.key, { have_it: 1, checked: 0 }); onClose(); }}>Have it — skip for these meals</Button>
        <Button variant="secondary" block onClick={onClose}>Done</Button>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Amounts come from recipes. To change them, edit the recipe or the meal’s servings.</p>
      </div>
    </Sheet>
  );
}

function ExtraSheet({ item, onClose }: { item: StateRow; onClose: () => void }) {
  const m = useMutate();
  const [label, setLabel] = useState(item.label ?? ""); const [qty, setQty] = useState(item.qty != null ? String(item.qty) : ""); const [unit, setUnit] = useState(item.unit ?? ""); const [section, setSection] = useState(item.section ?? "other");
  return (
    <Sheet title={item.label ?? "Extra item"} onClose={onClose}>
      <div className="h-stack">
        <Field label="Name" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="two-col"><Field label="Amount" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /><Field label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <label className="h-field"><span className="h-field__label">Store section</span><Select value={section} onChange={(e) => setSection(e.target.value)}>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
        <Button block onClick={async () => { await m.state(item.id, { label: label.trim() || item.label, qty: qty ? Number(qty.replace(",", ".")) : null, unit: unit || null, section }); onClose(); }}>Save</Button>
        <Button variant="text" className="danger-text" onClick={async () => { await m.state(item.id, { deleted: 1 }); onClose(); }}>Delete item</Button>
      </div>
    </Sheet>
  );
}
