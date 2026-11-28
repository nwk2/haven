import { familyOf, parseLine, parseList, type ParsedLine } from "@haven/meals-core";
import { Button, Dialog, Field, Icon, Select, Sheet, Stepper } from "@haven/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCtx } from "./ctx";
import { amount, fmt, ingredientOf, nameCase, newId, SECTIONS, useMealsData, useMutate, type MealsData, type Section, type StoredLine } from "./data";
import { DetailHeader } from "./shell";

interface Draft { title: string; base_servings: number; ingredients: StoredLine[]; steps: string[]; tags: string[]; source: string; photo_key?: string | null }
interface Pending { parsed: ParsedLine; group?: string }

export function RecipeEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { household, today, sync, user, features } = useCtx();
  const [editors, setEditors] = useState<Record<string, { name: string; at: number }>>({});
  const d = useMealsData();
  const m = useMutate();
  const nav = useNavigate();
  const [recipeId] = useState(id ?? newId());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<"saved" | "pending" | "invalid">("saved");
  // Don't scold an untouched form: the title error waits until the field has been left empty.
  const [titleTouched, setTitleTouched] = useState(false);
  const [line, setLine] = useState("");
  const [group, setGroup] = useState("");
  const [queue, setQueue] = useState<Pending[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [undo, setUndo] = useState<{ line: StoredLine; index: number } | null>(null);
  const exists = useRef(!!id);

  useEffect(() => {
    if (draft || !d) return;
    const r = id ? d.recipes.find((x) => x.id === id) : undefined;
    setDraft(r ? { title: r.title, base_servings: r.base_servings, ingredients: r.ingredients ?? [], steps: r.steps ?? [], tags: r.tags ?? [], source: r.source ?? "", photo_key: (r.photo_key as string | undefined) ?? null }
      : { title: params.get("title") ?? "", base_servings: household.default_servings ?? 2, ingredients: [], steps: [], tags: [], source: "" });
  }, [d, id, draft, params, household.default_servings]);

  const valid = !!draft?.title.trim() && !!draft?.ingredients.some((l) => l.ingredientId);
  // Autosave (PRD › Recipe editor rules): local first, synced by the outbox; new recipes wait until valid.
  useEffect(() => {
    if (!draft) return;
    if (!valid) { setSaved(exists.current ? "pending" : "invalid"); if (!exists.current) return; }
    setSaved("pending");
    const t = setTimeout(async () => {
      await m.put("meals_recipes", recipeId, { title: draft.title.trim(), base_servings: draft.base_servings, ingredients: draft.ingredients, steps: draft.steps.filter((s) => s.trim()), tags: draft.tags, source: draft.source.trim() || null, photo_key: draft.photo_key ?? null });
      exists.current = true; setSaved("saved");
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // "Jon is editing" (PRD › Recipe editor rules): announce while open, show others for 30 s after their last ping.
  useEffect(() => {
    const ping = () => sync.presence(recipeId, user.name.split(" ")[0]);
    ping(); const t = setInterval(ping, 15_000);
    const off = sync.onPresence((p) => setEditors((cur) => {
      const next = { ...cur };
      if (p.recipeId === recipeId && p.userId !== user.id) next[p.userId] = { name: p.name, at: p.at }; else delete next[p.userId];
      return next;
    }));
    return () => { clearInterval(t); off(); sync.presence(null, user.name.split(" ")[0]); };
  }, [sync, recipeId, user.id, user.name]);
  const others = Object.values(editors).filter((e) => Date.now() - e.at < 30_000);

  const parsed = useMemo(() => (line.trim() ? parseLine(line) : null), [line]);
  if (!d || !draft) return null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const groups = [...new Set(draft.ingredients.map((l) => l.group ?? "").filter(Boolean))];
  const findIngredient = (name: string) => [...d.ingredients.values()].find((i) => !i.merged_into && i.name.toLowerCase() === name.toLowerCase());

  function addParsed(p: ParsedLine, ingredientId: string, g?: string) {
    const l: StoredLine = { ingredientId, qty: p.qty, unit: p.qty != null ? p.unit : undefined, note: p.note, optional: p.optional || undefined, toTaste: p.toTaste || undefined, group: g || undefined };
    setDraft((cur) => cur && { ...cur, ingredients: [...cur.ingredients, l] });
  }
  function submit(items: Pending[]) {
    const unknown: Pending[] = [];
    for (const it of items) {
      const ing = findIngredient(it.parsed.name);
      if (ing) addParsed(it.parsed, ing.id, it.group); else unknown.push(it);
    }
    setQueue((q) => [...q, ...unknown]);
  }
  async function pickSection(section: Section) {
    const [first, ...rest] = queue;
    const ingId = newId();
    await m.put("meals_ingredients", ingId, { name: nameCase(first.parsed.name), section, default_unit: first.parsed.unit ?? null });
    addParsed(first.parsed, ingId, first.group);
    setQueue(rest);
  }
  const updateLine = (i: number, patch: Partial<StoredLine>) => set({ ingredients: draft.ingredients.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const move = (i: number, dir: -1 | 1) => { const a = [...draft.ingredients]; const j = i + dir; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; set({ ingredients: a }); };
  const remove = (i: number) => { setUndo({ line: draft.ingredients[i], index: i }); set({ ingredients: draft.ingredients.filter((_, j) => j !== i) }); };

  const planned = d.meals.filter((x) => x.recipe_id === recipeId && x.status === "planned" && x.date >= today);

  return (<>
    <DetailHeader title={id ? "Edit recipe" : "New recipe"} back={id ? `/m/meals/recipes/${id}` : "/m/meals/recipes"}
      right={<><span className="muted" role="status" style={{ fontSize: 11, marginRight: 6 }}>{saved === "saved" ? "Saved" : saved === "pending" ? "Saving…" : "Draft"}</span>
        <Button disabled={!valid} onClick={() => nav(`/m/meals/recipes/${recipeId}`)}>Done</Button></>} />
    <main className="page h-stack" style={{ gap: 18, paddingBottom: 48 }}>
      {others.length > 0 && <div className="note note--info" role="status">{others.map((o) => o.name).join(" and ")} {others.length === 1 ? "is" : "are"} editing this recipe too. The last change to each field wins.</div>}
      {features.photos && <PhotoField recipeId={recipeId} photoKey={draft.photo_key ?? null} onChange={(k) => set({ photo_key: k })} />}
      {planned.length > 0 && <div className="note note--trip">{`Planned ${planned.map((p) => `${fmt(p.date)} ${p.slot}`).join(", ")}. Saving updates its shopping list.`}</div>}
      <Field label="Title" value={draft.title} onChange={(e) => set({ title: e.target.value })} onBlur={() => setTitleTouched(true)} placeholder="e.g. Black bean tacos" error={!draft.title.trim() && titleTouched ? "Add a title to save this recipe" : undefined} />
      <div className="h-row"><span className="h-row__main"><span className="h-row__title">Recipe makes</span><span className="h-row__sub">Set servings per meal when planning</span></span><Stepper label="Servings" value={draft.base_servings} max={50} onChange={(n) => set({ base_servings: n })} /></div>

      <section className="h-stack" aria-labelledby="ingh">
        <div className="spread"><h2 id="ingh" className="editor__h">Ingredients</h2><button className="h-link editor__aside" onClick={() => setPasteOpen(true)}>Paste a list</button></div>
        <div className="h-card h-stack smart" style={{ padding: 8 }}>
          <form className="smart__row" onSubmit={(e) => { e.preventDefault(); if (parsed?.name) { submit([{ parsed, group }]); setLine(""); } }}>
            <label className="h-sr" htmlFor="smart">Add an ingredient</label>
            <input id="smart" className="h-input" style={{ border: 0 }} value={line} onChange={(e) => setLine(e.target.value)} placeholder="Add an ingredient, e.g. 2 cans black beans, drained" />
            <Button type="submit" disabled={!parsed?.name}>Add</Button>
          </form>
          {parsed?.name && <div className="chips" aria-live="polite"><span className="muted" style={{ fontSize: 11 }}>Read as</span>
            {parsed.qty != null && <span className="h-badge badge--accent-soft">{amount(parsed.qty, parsed.unit) || parsed.qty}</span>}
            <span className="h-badge badge--accent-soft">{parsed.name}</span>{parsed.note && <span className="h-badge badge--neutral">{parsed.note}</span>}
            {parsed.toTaste && <span className="h-badge badge--neutral">To taste</span>}{parsed.optional && <span className="h-badge badge--neutral">Optional</span>}
            {parsed.unread && <span className="h-badge badge--warn">No amount</span>}
            <span className="h-badge badge--neutral">{findIngredient(parsed.name) ? SECTIONS.find(([k]) => k === findIngredient(parsed.name)!.section)?.[1] : "New ingredient"}</span></div>}
          {(groups.length > 0 || group) && <label className="h-field"><span className="h-field__label">Group</span>
            <Select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">None</option>{[...new Set([...groups, group].filter(Boolean))].map((g) => <option key={g}>{g}</option>)}</Select></label>}
        </div>
        {!draft.ingredients.length && <div className="h-empty"><strong>No ingredients yet</strong><span className="muted" style={{ fontSize: 12 }}>Type one above or paste a whole list. At least one is needed to save.</span></div>}
        {["", ...groups].map((g) => {
          const rows = draft.ingredients.map((l, i) => ({ l, i })).filter(({ l }) => (l.group ?? "") === g);
          if (!rows.length) return null;
          return (<div key={g} className="h-stack">{g && <strong className="muted">{g}</strong>}
            <div className="h-card h-group">{rows.map(({ l, i }, pos) => <LineRow key={i} d={d} line={l} first={pos === 0} last={pos === rows.length - 1} recipeId={recipeId} onChange={(p) => updateLine(i, p)} onMove={(dir) => move(i, dir)} onRemove={() => remove(i)} />)}</div>
          </div>);
        })}
        <button className="h-link editor__add" onClick={() => setGroupOpen(true)}>+ Add group</button>
      </section>

      <section className="h-stack" aria-labelledby="sth">
        <h2 id="sth" className="editor__h">Steps</h2>
        {draft.steps.map((s, i) => (
          <div key={i} className="step-edit"><span className="step-num" aria-hidden="true">{i + 1}</span>
            <textarea className="h-input" aria-label={`Step ${i + 1}`} rows={2} value={s} onChange={(e) => set({ steps: draft.steps.map((x, j) => (j === i ? e.target.value : x)) })} />
            <button className="h-icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => set({ steps: draft.steps.filter((_, j) => j !== i) })}>×</button></div>
        ))}
        <button className="h-link editor__add" onClick={() => set({ steps: [...draft.steps, ""] })}>+ Add step</button>
      </section>

      <section className="h-stack" aria-labelledby="tgh">
        <h2 id="tgh" style={{ margin: 0, fontSize: 17 }}>Tags and source</h2>
        <div className="chips">{draft.tags.map((t) => <button key={t} className="h-chip" aria-pressed="true" aria-label={`Remove tag ${t}`} onClick={() => set({ tags: draft.tags.filter((x) => x !== t) })}>{t} ×</button>)}
          <form onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("tag")?.toString().trim(); if (v && !draft.tags.includes(v)) set({ tags: [...draft.tags, v] }); e.currentTarget.reset(); }}>
            <label className="h-sr" htmlFor="tag">Add tag</label><input id="tag" name="tag" className="h-input" style={{ width: 120 }} placeholder="+ Tag" /></form></div>
        <Field label="Source (optional)" value={draft.source} onChange={(e) => set({ source: e.target.value })} placeholder="Link or note" />
      </section>
    </main>

    {queue[0] && (
      <Sheet title={`Where do you find “${queue[0].parsed.name}”?`} onClose={() => setQueue(queue.slice(1))}>
        <p className="muted" style={{ marginTop: 0 }}>New ingredient. Haven remembers its aisle for every recipe and list.{queue.length > 1 ? ` ${queue.length - 1} more after this.` : ""}</p>
        <div className="h-stack">{SECTIONS.map(([k, label]) => <Button key={k} variant="secondary" block onClick={() => pickSection(k)}>{label}</Button>)}</div>
      </Sheet>
    )}
    {pasteOpen && <PasteDialog onClose={() => setPasteOpen(false)} onAdd={(lines) => { submit(lines.map((parsed) => ({ parsed, group }))); setPasteOpen(false); }} />}
    {groupOpen && <GroupDialog onClose={() => setGroupOpen(false)} onAdd={(name) => { setGroup(name); setGroupOpen(false); }} />}
    {undo && <UndoToast text="Ingredient removed" onUndo={() => { const a = [...draft.ingredients]; a.splice(undo.index, 0, undo.line); set({ ingredients: a }); setUndo(null); }} onDone={() => setUndo(null)} />}
  </>);
}

function LineRow({ d, line, first, last, recipeId, onChange, onMove, onRemove }: { d: MealsData; line: StoredLine; first: boolean; last: boolean; recipeId: string; onChange: (p: Partial<StoredLine>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const ing = ingredientOf(d, line.ingredientId);
  const unread = line.qty == null && !line.toTaste;
  // Unit hint (PRD › Recipe editor rules): this ingredient used in another unit family elsewhere.
  const fam = line.qty != null ? familyOf(line.unit) : null;
  const elsewhere = fam ? d.recipes.filter((r) => r.id !== recipeId).flatMap((r) => r.ingredients ?? []).filter((l) => ingredientOf(d, l.ingredientId)?.id === ing?.id && l.qty != null).map((l) => ({ fam: familyOf(l.unit), unit: l.unit })) : [];
  const other = elsewhere.find((e) => e.fam !== fam);
  return (
    <div className={`line${unread ? " line--warn" : other ? " line--hint" : ""}${editing ? " line--open" : ""}`}>
      {/* One compact row; moving and removing live in the panel it opens (they were 12px glyphs on every row). */}
      <button className="line__text" onClick={() => setEditing(!editing)} aria-expanded={editing}>
        <span className="line__amount">{line.toTaste ? "" : amount(line.qty, line.unit)}</span>
        <span className="line__name">{ing?.name ?? "?"}{line.note && <span className="muted">, {line.note}</span>}
          <span className="line__meta">{[line.toTaste && "To taste", line.optional && "Optional", SECTIONS.find(([k]) => k === ing?.section)?.[1]].filter(Boolean).join(" · ")}</span></span>
        <span className="line__chev" aria-hidden="true">{Icon.chevron}</span>
      </button>
      {unread && <div className="line__note">Couldn’t read an amount. Tap to fix, or mark To taste.</div>}
      {other && !unread && <div className="line__note">{ing?.name} is in {other.unit} on your other recipes, so they won’t merge on lists. Consider using {other.unit}.</div>}
      {editing && (
        <div className="line__edit">
          <Field label="Amount" inputMode="decimal" value={line.qty ?? ""} onChange={(e) => { const n = e.target.value === "" ? undefined : Number(e.target.value.replace(",", ".")); onChange({ qty: n != null && Number.isFinite(n) ? n : undefined, toTaste: undefined }); }} />
          <label className="h-field"><span className="h-field__label">Unit</span><Select value={line.unit ?? "whole"} onChange={(e) => onChange({ unit: e.target.value })}>
            {["whole", "g", "kg", "ml", "l", "tsp", "tbsp", "cup", "floz", "oz", "lb", "can", "pack", "clove", "bunch", "slice", "pinch"].map((u) => <option key={u} value={u}>{u === "floz" ? "fl oz" : u}</option>)}</Select></label>
          <Field label="Note" value={line.note ?? ""} onChange={(e) => onChange({ note: e.target.value || undefined })} />
          <div className="chips">
            <button className="h-chip" aria-pressed={!!line.optional} onClick={() => onChange({ optional: !line.optional || undefined })}>Optional</button>
            <button className="h-chip" aria-pressed={!!line.toTaste} onClick={() => onChange({ toTaste: !line.toTaste || undefined, qty: undefined })}>To taste</button>
          </div>
          <div className="line__actions">
            <Button variant="secondary" disabled={first} onClick={() => onMove(-1)}>Move up</Button>
            <Button variant="secondary" disabled={last} onClick={() => onMove(1)}>Move down</Button>
            <Button variant="text" className="danger-text" onClick={onRemove}>Remove</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PasteDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (lines: ParsedLine[]) => void }) {
  const [text, setText] = useState("");
  const lines = text.trim() ? parseList(text) : [];
  return (
    <Dialog title="Paste a list" body="One ingredient per line. Lines without an amount are kept and highlighted for you to check." onClose={onClose}>
      <Field label="Ingredients" textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"2 cans black beans\n150 g feta\nSalt, to taste"} />
      <Button disabled={!lines.length} onClick={() => onAdd(lines)}>{lines.length ? `Add ${lines.length} ${lines.length === 1 ? "line" : "lines"}` : "Add"}</Button>
      <Button variant="text" onClick={onClose}>Cancel</Button>
    </Dialog>
  );
}

function GroupDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog title="Add a group" body="Groups keep a recipe's ingredients organised, e.g. For the salsa." onClose={onClose}>
      <Field label="Group name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. For the salsa" />
      <Button disabled={!name.trim()} onClick={() => onAdd(name.trim())}>Add group</Button>
      <Button variant="text" onClick={onClose}>Cancel</Button>
    </Dialog>
  );
}

export function UndoToast({ text, onUndo, onDone }: { text: string; onUndo: () => void; onDone: () => void }) {
  // The timer keys on the toast's text, not on the onDone identity: every call site passes a fresh
  // inline arrow, so depending on onDone reset the 6s timer on every parent re-render and the
  // toast never dismissed while sync kept re-rendering. The ref always calls the latest onDone.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => { const t = setTimeout(() => doneRef.current(), 6000); return () => clearTimeout(t); }, [text]);
  return <div className="h-toast" role="status" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}><span>{text}</span><Button variant="secondary" onClick={onUndo}>Undo</Button></div>;
}

/** Resizes on the phone to 1600 px and 400 px WebP before upload (Technical spec › Photos). */
async function resize(file: File, max: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
}

function PhotoField({ recipeId, photoKey, onChange }: { recipeId: string; photoKey: string | null; onChange: (k: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function pick(file: File) {
    setBusy(true); setError(undefined);
    try {
      const id = crypto.randomUUID();
      const up = async (kind: "full" | "thumb", max: number) => {
        const res = await fetch(`/api/photos/${recipeId}/${kind}?id=${id}`, { method: "PUT", headers: { "content-type": "image/webp", "x-haven": "1" }, body: await resize(file, max) });
        if (!res.ok) throw new Error(String(res.status));
        return ((await res.json()) as { key: string }).key;
      };
      await up("thumb", 400);
      onChange(await up("full", 1600));
    } catch { setError("Couldn’t upload the photo. Photos need a connection."); }
    setBusy(false);
  }
  return (
    <div className="photo-field">
      {photoKey ? <img src={`/api/photos/${photoKey}`} alt="" className="photo-preview" /> : <span className="photo-empty" aria-hidden="true">+</span>}
      <div className="h-stack" style={{ gap: 4 }}>
        <label className="h-btn h-btn--secondary">{busy ? "Uploading…" : photoKey ? "Change photo" : "Add photo"}<input type="file" accept="image/*" className="h-sr" disabled={busy} onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} /></label>
        {photoKey && <button className="h-btn h-btn--text" onClick={() => onChange(null)}>Remove photo</button>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
