import { Button, Dialog, Field, Select } from "@haven/ui";
import { useState } from "react";
import { useCtx } from "./ctx";
import { plural, SECTIONS, useMealsData, useMutate, type Ingredient } from "./data";
import { DetailHeader } from "./shell";

/** Ingredient catalog: rename, change section, merge duplicates (Owner). */
export function Ingredients() {
  const { user } = useCtx();
  const d = useMealsData();
  const m = useMutate();
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Ingredient | null>(null);
  const [merge, setMerge] = useState<[Ingredient, Ingredient] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  if (!d) return null;
  const all = [...d.ingredients.values()].filter((i) => !i.merged_into);
  const uses = (id: string) => d.recipes.filter((r) => r.ingredients?.some((l) => l.ingredientId === id)).length;
  const norm = (s: string) => s.toLowerCase().replace(/\b(cloves?|fresh|dried|chopped)\b/g, "").replace(/(es|s)\b/g, "").trim();
  const dup = user.role === "owner" ? (() => { for (const a of all) for (const b of all) if (a.id < b.id && norm(a.name) === norm(b.name) && !dismissed.includes(a.id + b.id)) return [a, b] as [Ingredient, Ingredient]; return null; })() : null;
  const shown = all.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));

  async function doMerge(from: Ingredient, into: Ingredient) {
    for (const r of d!.recipes) if (r.ingredients?.some((l) => l.ingredientId === from.id))
      await m.put("meals_recipes", r.id, { ingredients: r.ingredients.map((l) => (l.ingredientId === from.id ? { ...l, ingredientId: into.id } : l)) });
    await m.put("meals_ingredients", from.id, { merged_into: into.id });
    setMerge(null);
  }

  return (<>
    <DetailHeader title="Ingredients" back="/m/meals/recipes" />
    <main className="page h-stack" style={{ paddingBottom: 40 }}>
      <label className="h-field"><span className="h-sr">Search ingredients</span><input className="h-input" type="search" placeholder={`Search ${all.length} ingredients`} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {dup && <section className="note note--trip h-stack"><strong>Possible duplicate</strong><span><strong>{dup[1].name}</strong> ({plural(uses(dup[1].id), "recipe")}) looks like <strong>{dup[0].name}</strong> ({plural(uses(dup[0].id), "recipe")}).</span>
        <div className="row-actions"><Button onClick={() => setMerge(uses(dup[0].id) >= uses(dup[1].id) ? [dup[1], dup[0]] : dup)}>Merge…</Button><Button variant="secondary" onClick={() => setDismissed([...dismissed, dup[0].id + dup[1].id])}>Not the same</Button></div></section>}
      {SECTIONS.map(([k, label]) => {
        const items = shown.filter((i) => i.section === k).sort((a, b) => a.name.localeCompare(b.name));
        if (!items.length) return null;
        return (<section key={k}><h2 className="h-section-title">{label}</h2><div className="h-card h-group">{items.map((i) => (
          <button key={i.id} className="h-row settings-row" onClick={() => setEdit(i)}><span className="h-row__main"><span className="h-row__title">{i.name}</span></span><span className="muted ing-uses">{uses(i.id) ? plural(uses(i.id), "recipe") : "Unused"}</span></button>))}</div></section>);
      })}
      <span className="muted ing-uses">Tap an ingredient to rename it or change its store section.</span>
    </main>
    {edit && <EditIngredient ing={edit} onClose={() => setEdit(null)} />}
    {merge && <Dialog title={`Merge “${merge[0].name}” into “${merge[1].name}”?`} body={`${uses(merge[0].id) === 1 ? "The recipe" : `The ${uses(merge[0].id)} recipes`} using ${merge[0].name} will use ${merge[1].name}. Amounts and units stay as written; matching list lines combine.`} onClose={() => setMerge(null)}>
      <Button onClick={() => doMerge(merge[0], merge[1])}>Merge</Button><Button variant="text" onClick={() => setMerge(null)}>Cancel</Button></Dialog>}
  </>);
}

function EditIngredient({ ing, onClose }: { ing: Ingredient; onClose: () => void }) {
  const m = useMutate();
  const [name, setName] = useState(ing.name); const [section, setSection] = useState(ing.section);
  return (
    <Dialog title={ing.name} onClose={onClose}>
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="h-field"><span className="h-field__label">Store section</span><Select value={section} onChange={(e) => setSection(e.target.value as typeof section)}>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
      <Button disabled={!name.trim()} onClick={async () => { await m.put("meals_ingredients", ing.id, { name: name.trim(), section }); onClose(); }}>Save</Button>
      <Button variant="text" onClick={onClose}>Cancel</Button>
    </Dialog>
  );
}
