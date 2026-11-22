import { Button, Dialog, Icon } from "@haven/ui";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Skeleton } from "./Plan";
import { useCtx } from "./ctx";
import { amount, fmt, ingredientOf, newId, useMealsData, useMutate } from "./data";
import { DetailHeader, ModuleShell } from "./shell";

export function Recipes() {
  const { features } = useCtx();
  const d = useMealsData();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  if (!d) return <ModuleShell title="Recipes" tab="recipes"><Skeleton /></ModuleShell>;
  const active = d.recipes.filter((r) => !r.archived_at);
  const tags = [...new Set(active.flatMap((r) => r.tags ?? []))].sort();
  const ql = q.toLowerCase();
  const list = active.filter((r) => (!tag || r.tags?.includes(tag)) && (!ql || r.title.toLowerCase().includes(ql) || r.tags?.some((t) => t.toLowerCase().includes(ql))
    || r.ingredients?.some((l) => ingredientOf(d, l.ingredientId)?.name.toLowerCase().includes(ql))));

  return (
    <ModuleShell title="Recipes" tab="recipes" header={<div className="h-stack">
      <label className="h-field"><span className="h-sr">Search recipes</span><input className="h-input" type="search" placeholder={`Search ${active.length} recipes`} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {tags.length > 0 && <div className="chips" role="group" aria-label="Filter by tag"><button className="h-chip" aria-pressed={!tag} onClick={() => setTag(null)}>All</button>{tags.map((t) => <button key={t} className="h-chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>{t}</button>)}</div>}
      <Link to="/m/meals/ingredients" style={{ alignSelf: "flex-end", fontSize: 13, fontWeight: 600 }}>Manage ingredients</Link>
    </div>}>
      {!active.length && <div className="empty-state"><h2>Your recipe box is empty</h2><p className="muted">Add your first recipe — typing or pasting the ingredients takes about two minutes.</p><Link className="h-btn h-btn--primary" to="/m/meals/recipes/new">New recipe</Link></div>}
      {active.length > 0 && !list.length && <div className="empty-state"><h2>No recipes match “{q}”</h2><p className="muted">Search looks at titles, tags and ingredients.</p><Link className="h-btn h-btn--primary" to={`/m/meals/recipes/new?title=${encodeURIComponent(q)}`}>Create “{q}”</Link><Button variant="text" onClick={() => { setQ(""); setTag(null); }}>Clear search</Button></div>}
      {list.map((r) => (
        <Link key={r.id} to={`/m/meals/recipes/${r.id}`} className="h-row">
          {r.photo_key && features.photos ? <img className="thumb" src={`/api/photos/${String(r.photo_key).replace("-full.webp", "-thumb.webp")}`} alt="" loading="lazy" /> : <span className="thumb" aria-hidden="true">{r.title[0]}</span>}
          <span className="h-row__main"><span className="h-row__title">{r.title}</span><span className="h-row__sub">Makes {r.base_servings}{r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}</span></span>{Icon.chevron}
        </Link>
      ))}
      <Link to="/m/meals/recipes/new" className="h-btn h-btn--primary fab">+ New recipe</Link>
    </ModuleShell>
  );
}

export function RecipeDetail() {
  const { id } = useParams();
  const { today, features } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const nav = useNavigate();
  const [confirm, setConfirm] = useState(false);
  if (!d) return null;
  const r = d.recipes.find((x) => x.id === id);
  if (!r) return <><DetailHeader title="Recipe" back="/m/meals/recipes" /><main className="page"><p>This recipe was deleted.</p></main></>;
  const planned = d.meals.filter((x) => x.recipe_id === r.id && x.status === "planned" && x.date >= today);
  const groups = [...new Set((r.ingredients ?? []).map((l) => l.group ?? ""))];

  return (<>
    <DetailHeader title="Recipe" back="/m/meals/recipes" right={<Link className="h-btn h-btn--secondary" to={`/m/meals/recipes/${r.id}/edit`}>Edit</Link>} />
    <main className="page h-stack" style={{ gap: 18, paddingBottom: 40 }}>
      {r.photo_key && features.photos ? <img src={`/api/photos/${r.photo_key}`} alt={`Photo of ${r.title}`} className="hero-photo" /> : null}
      <div className="h-stack"><h2 style={{ margin: 0, fontSize: 26 }}>{r.title}</h2>
        <span className="muted">Makes {r.base_servings}{r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}{r.source ? ` · from ${r.source}` : ""}</span>
        {planned.map((p) => <span key={p.id} className="h-badge badge--trip">Planned {fmt(p.date)} {p.slot} · {p.servings} servings</span>)}
        <Link className="h-btn h-btn--primary" to={`/m/meals/plan`}>Plan this</Link></div>
      <section aria-labelledby="ing"><div className="spread"><h3 id="ing" style={{ margin: 0 }}>Ingredients</h3><span className="muted" style={{ fontSize: 12 }}>For {r.base_servings} servings, as written</span></div>
        {groups.map((g) => (<div key={g}>{g && <h4 className="muted" style={{ margin: "10px 0 0" }}>{g}</h4>}
          <ul className="plain">{r.ingredients.filter((l) => (l.group ?? "") === g).map((l, i) => (
            <li key={i} className="ing-line"><strong>{l.toTaste ? "" : amount(l.qty, l.unit)}</strong><span>{ingredientOf(d, l.ingredientId)?.name ?? "?"}{l.note ? <span className="muted">, {l.note}</span> : null}
              {l.toTaste && <span className="h-badge badge--neutral">To taste</span>}{l.optional && <span className="h-badge badge--neutral">Optional</span>}</span></li>))}</ul></div>))}
      </section>
      {r.steps?.length > 0 && <section aria-labelledby="st"><h3 id="st" style={{ margin: 0 }}>Steps</h3><ol className="steps">{r.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></section>}
      <div className="row-actions">
        <Button variant="secondary" onClick={async () => { const nid = newId(); await m.put("meals_recipes", nid, { title: `${r.title} (copy)`, base_servings: r.base_servings, ingredients: r.ingredients, steps: r.steps, tags: r.tags, source: r.source ?? null }); nav(`/m/meals/recipes/${nid}/edit`); }}>Duplicate</Button>
        <Button variant="secondary" onClick={async () => { await m.put("meals_recipes", r.id, { archived_at: r.archived_at ? null : Date.now() }); }}>{r.archived_at ? "Unarchive" : "Archive"}</Button>
        <Button variant="text" className="danger-text" onClick={() => setConfirm(true)}>Delete</Button>
      </div>
    </main>
    {confirm && <Dialog title={`Delete “${r.title}”?`} body={planned.length ? `It’s planned for ${planned.map((p) => fmt(p.date)).join(", ")}. Those meals keep a read-only copy and their list items stay.` : "It disappears from your recipes and search."} onClose={() => setConfirm(false)}>
      <Button variant="danger" onClick={async () => {
        for (const p of d.meals.filter((x) => x.recipe_id === r.id)) await m.put("meals_planned", p.id, { recipe_snapshot: { title: r.title, base_servings: r.base_servings, ingredients: r.ingredients } });
        await m.put("meals_recipes", r.id, { deleted_at: Date.now(), deleted: 1 }); nav("/m/meals/recipes");
      }}>Delete recipe</Button>
      <Button variant="secondary" onClick={async () => { await m.put("meals_recipes", r.id, { archived_at: Date.now() }); setConfirm(false); }}>Archive instead</Button>
      <Button variant="text" onClick={() => setConfirm(false)}>Cancel</Button></Dialog>}
  </>);
}
