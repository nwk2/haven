import { addDays, nextDue, repeatLabel, type Repeat, type RepeatKind } from "@haven/todos-core";
import { Button, Field, Select, Sheet, Switch } from "@haven/ui";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCtx } from "./ctx";
import { dayLabel, firstName, newId, timeLabel, useMutate, whenLabel, type TItem, type TList } from "./data";
import type { Undo } from "./screens";

const KINDS: RepeatKind[] = ["daily", "weekly", "biweekly", "monthly", "monthly_nth", "yearly", "after"];

/** Item sheet: every change saves as you make it (like Meals' item sheet). */
export function ItemSheet({ item, list, onClose, setUndo }: { item: TItem; list: TList; onClose: () => void; setUndo: (u: Undo) => void }) {
  const { user, members, today } = useCtx();
  const m = useMutate();
  const [f, setF] = useState(item);
  const save = (p: Partial<TItem>) => { setF((x) => ({ ...x, ...p })); void m.item(item.id, p); };
  const name = (id?: string | null) => firstName(members.find((x) => x.id === id)?.name);
  const repeatValue = f.repeat ? f.repeat.kind : "";
  const tomorrow = addDays(today, 1);
  const otherDay = !!f.due_date && f.due_date !== today && f.due_date !== tomorrow;
  // No date clears the time and repeat too (both need a day).
  // "Sat 28" fits a segment; the full date is in its accessible name.
  const shortDay = (d: string) => { const [y, mo, day] = d.split("-").map(Number); return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" }).format(Date.UTC(y, mo - 1, day)); };
  const setDay = (d: string | null) => save(d ? { due_date: d } : { due_date: null, due_time: null, repeat: null });
  const setRepeat = (k: string) => save({ repeat: k ? ({ kind: k as RepeatKind, ...(k === "after" ? { n: f.repeat?.n ?? 3 } : {}) } as Repeat) : null });

  return (
    <Sheet title={list.checklist ? "Item" : "Task"} onClose={onClose}>
      <div className="h-stack">
        <Field label="Title" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} onBlur={() => f.title.trim() && f.title !== item.title && save({ title: f.title.trim() })} />
        {!list.checklist && (<>
          {/* Due and Time as the app's segmented control (Nov 2026 polish); Time and Repeat appear once there's a day.
              "Pick…" and "Set time" are the phone's own pickers, laid invisibly over the segment. */}
          <div className="td-field"><span className="h-field__label" id="due-l">Due</span>
            <div className="h-seg td-seg" role="radiogroup" aria-labelledby="due-l">
              <button type="button" role="radio" aria-checked={!f.due_date} onClick={() => setDay(null)}>No date</button>
              <button type="button" role="radio" aria-checked={f.due_date === today} onClick={() => setDay(today)}>Today</button>
              <button type="button" role="radio" aria-checked={f.due_date === tomorrow} onClick={() => setDay(tomorrow)}>Tomorrow</button>
              <label className="td-seg__pick" role="radio" aria-checked={otherDay}>
                <span>{otherDay ? shortDay(f.due_date!) : "Pick…"}</span>
                <input type="date" aria-label={otherDay ? `Due ${dayLabel(f.due_date!, today)}, change date` : "Pick a date"} value={f.due_date ?? ""} onChange={(e) => setDay(e.target.value || null)} />
              </label>
            </div>
          </div>
          {f.due_date && (<>
            <div className="td-field"><span className="h-field__label" id="time-l">Time</span>
              <div className="h-seg td-seg" role="radiogroup" aria-labelledby="time-l">
                <button type="button" role="radio" aria-checked={!f.due_time} onClick={() => save({ due_time: null })}>Any time</button>
                <label className="td-seg__pick" role="radio" aria-checked={!!f.due_time}>
                  <span>{f.due_time ? timeLabel(f.due_time) : "Set time"}</span>
                  <input type="time" aria-label={f.due_time ? `At ${timeLabel(f.due_time)}, change time` : "Set a time"} value={f.due_time ?? ""} onChange={(e) => save({ due_time: e.target.value || null })} />
                </label>
              </div>
            </div>
            <label className="td-field"><span className="h-field__label">Repeat</span>
              <Select value={repeatValue} onChange={(e) => setRepeat(e.target.value)}>
                <option value="">Doesn’t repeat</option>
                {KINDS.map((k) => <option key={k} value={k}>{repeatLabel({ kind: k, n: f.repeat?.n ?? 3 }, f.due_date)}</option>)}
              </Select>
            </label>
          </>)}
          {f.repeat?.kind === "after" && (
            <label className="td-field"><span className="h-field__label">Days after it’s done</span>
              <Select value={f.repeat.n ?? 3} onChange={(e) => save({ repeat: { kind: "after", n: Number(e.target.value) } })}>
                {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </label>
          )}
          <div className="td-field"><span className="h-field__label">Who</span>
            <div className="td-people" role="radiogroup" aria-label="Who">
              <button type="button" role="radio" aria-checked={!f.assignee_id} onClick={() => save({ assignee_id: null })}>Anyone</button>
              {members.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={f.assignee_id === p.id} onClick={() => {
                  if (f.assignee_id === p.id) return;
                  save({ assignee_id: p.id });
                  if (p.id !== user.id) { void m.activity(`${firstName(user.name)} gave ${f.title} to ${firstName(p.name)}`); setUndo({ text: `Gave it to ${firstName(p.name)}. They’ll get a notification.` }); }
                }}>{firstName(p.name)}{p.id === user.id ? " (you)" : ""}</button>
              ))}
            </div>
          </div>
        </>)}
        <Field label="Note" textarea rows={2} value={f.note ?? ""} maxLength={1000} placeholder="Optional" onChange={(e) => setF({ ...f, note: e.target.value })} onBlur={() => (f.note ?? "") !== (item.note ?? "") && save({ note: f.note || null })} />
        <p className="muted td-facts">
          {item.created_by && <>Added by {name(item.created_by)}{item.created_at ? ` · ${whenLabel(item.created_at)}` : ""}</>}
          {item.last_done_at && <><br />Last done by {name(item.last_done_by)} · {whenLabel(item.last_done_at)}</>}
          {item.done_at && <><br />Done by {name(item.done_by)} · {whenLabel(item.done_at)}</>}
        </p>
        {!list.checklist && f.repeat && f.due_date && !item.done_at && (
          <Button variant="secondary" block onClick={() => { const next = nextDue(f.repeat!, f.due_date!, today); const was = f.due_date; save({ due_date: next }); setUndo({ text: `Skipped. Next: ${dayLabel(next, today)}`, undo: () => void m.item(item.id, { due_date: was }) }); onClose(); }}>Skip this time</Button>
        )}
        <Button variant="secondary" className="td-danger" block onClick={() => { void m.item(item.id, { deleted: 1 }); setUndo({ text: "Deleted", undo: () => void m.item(item.id, { deleted: 0 }) }); onClose(); }}>Delete</Button>
        <Button variant="secondary" block onClick={onClose}>Done</Button>
      </div>
    </Sheet>
  );
}

/** ⋯ on a list: Rename, Copy list, Reusable checklist, Remind me, Delete list. */
export function ListMenu({ list, items, muted, onClose, setUndo }: { list: TList; items: TItem[]; muted: boolean; onClose: () => void; setUndo: (u: Undo) => void }) {
  const { user } = useCtx();
  const m = useMutate();
  const nav = useNavigate();
  const [rename, setRename] = useState<string | null>(null);
  if (rename !== null) return (
    <Sheet title="Rename list" onClose={onClose}>
      <form className="h-stack" onSubmit={(e) => { e.preventDefault(); if (rename.trim()) void m.list(list.id, { name: rename.trim() }); onClose(); }}>
        <Field label="Name" value={rename} maxLength={60} onChange={(e) => setRename(e.target.value)} autoFocus />
        <Button type="submit" block disabled={!rename.trim()}>Save</Button>
      </form>
    </Sheet>
  );
  return (
    <Sheet title={`${list.emoji ? `${list.emoji} ` : ""}${list.name}`} onClose={onClose}>
      <div className="h-stack">
      <div className="h-card td-menu">
        <button type="button" className="td-menu__row" onClick={() => setRename(list.name)}>Rename</button>
        <button type="button" className="td-menu__row" onClick={async () => {
          const id = newId();
          await m.list(id, { name: `${list.name} (copy)`, emoji: list.emoji ?? null, checklist: list.checklist, position: (list.position ?? 0) + 0.5, created_by: user.id });
          for (const i of items.filter((x) => !x.done_at)) await m.item(newId(), { list_id: id, title: i.title, note: i.note ?? null, due_date: i.due_date ?? null, due_time: i.due_time ?? null, repeat: i.repeat ?? null, assignee_id: i.assignee_id ?? null, position: i.position, checked: 0, created_by: user.id, created_at: Date.now() });
          onClose(); nav(`/m/todos/list/${id}`); setUndo({ text: "Copied. Rename it from ⋯ when you’re ready." });
        }}>Copy list</button>
        <div className="td-menu__row"><span>Reusable checklist<small>Ticked items stay; reset with Uncheck all</small></span>
          <Switch label="Reusable checklist" checked={!!list.checklist} onChange={(v) => void m.list(list.id, { checklist: v ? 1 : 0 })} /></div>
        <div className="td-menu__row"><span>Remind me<small>{muted ? "Muted for you" : "Reminders on for you"}</small></span>
          <Switch label="Remind me about this list" checked={!muted} onChange={(v) => void m.mute(list.id, !v)} /></div>
        <button type="button" className="td-menu__row td-danger" onClick={() => { void m.list(list.id, { deleted: 1 }); onClose(); nav("/m/todos"); setUndo({ text: "List deleted", undo: () => void m.list(list.id, { deleted: 0 }) }); }}>Delete list</button>
      </div>
      <Button variant="secondary" block onClick={onClose}>Done</Button>
      </div>
    </Sheet>
  );
}

const EMOJI = ["🧹", "🏠", "🧳", "🛠️", "🌱", "🎄", "🐶", "📦", "🧺", "🚗"];
export function NewListSheet({ position, onClose }: { position: number; onClose: () => void }) {
  const { user } = useCtx();
  const m = useMutate();
  const nav = useNavigate();
  const [name, setName] = useState(""); const [emoji, setEmoji] = useState("🧹"); const [checklist, setChecklist] = useState(false);
  return (
    <Sheet title="New list" onClose={onClose}>
      <form className="h-stack" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const id = newId(); await m.list(id, { name: name.trim(), emoji, checklist: checklist ? 1 : 0, position, created_by: user.id }); onClose(); nav(`/m/todos/list/${id}`); }}>
        <Field label="Name" value={name} maxLength={60} placeholder="e.g. Chores, Beach trip" onChange={(e) => setName(e.target.value)} autoFocus />
        <div><span className="h-field__label">Icon</span>
          <div className="td-emoji" role="radiogroup" aria-label="Icon">{EMOJI.map((x) => <button key={x} type="button" role="radio" aria-checked={emoji === x} onClick={() => setEmoji(x)}>{x}</button>)}</div></div>
        <div className="td-menu__row" style={{ padding: 0 }}><span>Reusable checklist<small>For packing lists and routines: ticked items stay, and Uncheck all resets it.</small></span>
          <Switch label="Reusable checklist" checked={checklist} onChange={setChecklist} /></div>
        <Button type="submit" block disabled={!name.trim()}>Create list</Button>
      </form>
    </Sheet>
  );
}
