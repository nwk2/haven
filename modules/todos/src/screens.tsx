import { dueState, nextDue, repeatShort } from "@haven/todos-core";
import { Button, Icon } from "@haven/ui";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCtx } from "./ctx";
import { dayLabel, firstName, isLate, newId, timeLabel, useMutate, useNowHM, useTodos, visibleDone, type TData, type TItem, type TList } from "./data";
import { ItemSheet, ListMenu, NewListSheet } from "./sheets";
import { RemindersCard } from "./remind";

/* ── Shared pieces ── */

export function Header({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  const { household } = useCtx();
  return (
    <header className="mod-header">
      <div className="h-modhead">
        <Link to={back ?? "/"} className="h-icon-btn" aria-label={back ? "Back to Tasks" : `Back to ${household.name}`} style={{ marginLeft: -10 }}>{Icon.back}</Link>
        {/* The module name only inside a list ("Tasks › Chores"); on the Tasks home it would repeat the title. */}
        <div style={{ flex: 1, minWidth: 0 }}>{back && <div className="h-modhead__eyebrow">Tasks</div>}<h1>{title}</h1></div>
        {right}
      </div>
    </header>
  );
}

export interface Undo { text: string; undo?: () => void }
export function Toast({ t, onDone }: { t: Undo; onDone: () => void }) {
  useEffect(() => { const x = setTimeout(onDone, 5000); return () => clearTimeout(x); }, [t, onDone]);
  return <div className={`h-toast${t.undo ? " h-toast--row" : ""}`} role="status"><span>{t.text}</span>{t.undo && <button type="button" className="h-toast__action" onClick={() => { t.undo!(); onDone(); }}>Undo</button>}</div>;
}

/** Ticking: checklists toggle in place; repeating items move to their next date; one-time items go to Done. */
export function useTick(setUndo: (u: Undo) => void) {
  const { user, today } = useCtx();
  const m = useMutate();
  return (i: TItem, list: TList) => {
    if (list.checklist) { void m.item(i.id, { checked: i.checked ? 0 : 1 }); return; }
    if (i.done_at) { void m.item(i.id, { done_at: null, done_by: null }); return; }
    if (i.repeat && i.due_date) {
      const before = { due_date: i.due_date, last_done_at: i.last_done_at ?? null, last_done_by: i.last_done_by ?? null };
      const next = nextDue(i.repeat, i.due_date, today);
      void m.item(i.id, { due_date: next, last_done_at: Date.now(), last_done_by: user.id });
      void m.activity(`${firstName(user.name)} ticked ${i.title}`);
      setUndo({ text: `Done. Next: ${dayLabel(next, today)}`, undo: () => void m.item(i.id, before) });
      return;
    }
    void m.item(i.id, { done_at: Date.now(), done_by: user.id });
    void m.activity(`${firstName(user.name)} ticked ${i.title}`);
    setUndo({ text: "Done · moved to Done", undo: () => void m.item(i.id, { done_at: null, done_by: null }) });
  };
}

function Avatar({ id }: { id?: string | null }) {
  const { members } = useCtx();
  if (!id) return null;
  const name = members.find((x) => x.id === id)?.name ?? "?";
  const hue = [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 4, 0) + 1;
  return <span className={`td-who td-who--${hue}`} aria-label={`Assigned to ${name}`} title={name}>{name[0]}</span>;
}

export function ItemRow({ i, list, onTick, onOpen, showList }: { i: TItem; list: TList; onTick: () => void; onOpen: () => void; showList?: boolean }) {
  const { today, members, household } = useCtx();
  const hm = useNowHM(household.timezone);
  const checked = list.checklist ? !!i.checked : !!i.done_at;
  const meta: ReactNode[] = [];
  if (!list.checklist) {
    if (i.done_at) meta.push(<span key="d">Done by {firstName(members.find((x) => x.id === i.done_by)?.name)}</span>);
    else {
      const st = dueState(i.due_date, today);
      if (st === "overdue") { const n = Math.round((Date.parse(today) - Date.parse(i.due_date!)) / 86_400_000); meta.push(<span key="due" className="td-late">Overdue · {n} day{n === 1 ? "" : "s"}</span>); }
      // Today at a time that has passed reads as late (red), like an earlier day.
      else if (i.due_date) meta.push(<span key="due" className={isLate(i, today, hm) ? "td-late" : st === "today" ? "td-today" : undefined}>{dayLabel(i.due_date, today)}{i.due_time ? ` · ${timeLabel(i.due_time)}` : ""}</span>);
      if (i.repeat) meta.push(<span key="r">↻ {repeatShort(i.repeat)}</span>);
    }
    if (showList) meta.push(<span key="l">{list.emoji ? `${list.emoji} ` : ""}{list.name}</span>);
  }
  return (
    <div className={`td-item${checked ? " td-item--done" : ""}`}>
      <button type="button" className="td-tick" role="checkbox" aria-checked={checked} aria-label={`${checked ? "Untick" : "Tick"} ${i.title}`} onClick={onTick}><span>{checked ? Icon.check : null}</span></button>
      <button type="button" className="td-item__main" onClick={onOpen}>
        <span className="td-item__title">{i.title}</span>
        {meta.length > 0 && <span className="td-item__meta">{meta}</span>}
      </button>
      {!list.checklist && !i.done_at && <Avatar id={i.assignee_id} />}
    </div>
  );
}

/* ── To-dos home: Today, then the lists ── */

export function Home() {
  const { user, today } = useCtx();
  const d = useTodos();
  const m = useMutate();
  const nav = useNavigate();
  const [open, setOpen] = useState<TItem | null>(null);
  const [newList, setNewList] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const tick = useTick(setUndo);
  if (!d) return <><Header title="Tasks" /><main className="page"><div className="h-skeleton" style={{ height: 200 }} /></main></>;
  const listOf = (id: string) => d.lists.find((l) => l.id === id)!;
  const todayItems = d.items.filter((i) => !listOf(i.list_id).checklist && !i.done_at && i.due_date && i.due_date <= today)
    .sort((a, b) => Number(b.assignee_id === user.id) - Number(a.assignee_id === user.id) || a.due_date!.localeCompare(b.due_date!) || (a.due_time ?? "99").localeCompare(b.due_time ?? "99"));

  async function starter(name: string, emoji: string, checklist: boolean) {
    const id = newId();
    await m.list(id, { name, emoji, checklist: checklist ? 1 : 0, position: d!.lists.length, created_by: user.id });
    nav(`/m/todos/list/${id}`);
  }

  return (<>
    <Header title="Tasks" />
    <main className="page h-stack mod-main">
      {d.lists.length > 0 && <RemindersCard onOn={() => setUndo({ text: "Reminders are on for this phone" })} />}
      <section aria-labelledby="today-h">
        <div className="td-sec"><h2 id="today-h">Today</h2><span>{todayItems.length ? `${todayItems.length} due` : ""}</span></div>
        {todayItems.length
          ? <div className="h-card td-card">{todayItems.map((i) => <ItemRow key={i.id} i={i} list={listOf(i.list_id)} showList onTick={() => tick(i, listOf(i.list_id))} onOpen={() => setOpen(i)} />)}</div>
          : <div className="h-card td-empty">{d.lists.length ? "Nothing due today." : "Nothing here yet."}</div>}
      </section>
      <section aria-labelledby="lists-h">
        <div className="td-sec"><h2 id="lists-h">Lists</h2></div>
        {d.lists.length > 0 && <div className="h-card td-card">{d.lists.map((l) => <ListRow key={l.id} l={l} d={d} />)}</div>}
        {!d.lists.length && (
          <div className="h-card h-stack" style={{ padding: 16 }}>
            <p style={{ margin: 0 }}>Shared lists for the household: repeating chores, one-time jobs, and checklists you reuse.</p>
            <div className="chips">
              <button type="button" className="h-chip" onClick={() => starter("Chores", "🧹", false)}>🧹 Chores</button>
              <button type="button" className="h-chip" onClick={() => starter("Home admin", "🏠", false)}>🏠 Home admin</button>
              <button type="button" className="h-chip" onClick={() => starter("Packing list", "🧳", true)}>🧳 Packing list</button>
            </div>
          </div>
        )}
        <div style={{ marginTop: 10 }}><Button variant="secondary" block onClick={() => setNewList(true)}>+ New list</Button></div>
      </section>
    </main>
    {open && <ItemSheet item={open} list={listOf(open.list_id)} onClose={() => setOpen(null)} setUndo={setUndo} />}
    {newList && <NewListSheet position={d.lists.length} onClose={() => setNewList(false)} />}
    {undo && <Toast t={undo} onDone={() => setUndo(null)} />}
  </>);
}

function ListRow({ l, d }: { l: TList; d: TData }) {
  const { today, household } = useCtx();
  const hm = useNowHM(household.timezone);
  const its = d.items.filter((i) => i.list_id === l.id);
  let sub: string, badge: ReactNode = null;
  if (l.checklist) { const c = its.filter((i) => i.checked).length; sub = "Reusable checklist"; badge = <span className="td-badge">{c} of {its.length}</span>; }
  else {
    const open = its.filter((i) => !i.done_at);
    const due = open.filter((i) => i.due_date && i.due_date <= today);
    sub = `${open.length} open`;
    if (due.length) badge = <span className={`td-badge${due.some((i) => isLate(i, today, hm)) ? " td-badge--late" : ""}`}>{due.length} due</span>;
  }
  return (
    <Link to={`/m/todos/list/${l.id}`} className="td-listrow">
      <span className="td-listrow__emoji" aria-hidden="true">{l.emoji || "📝"}</span>
      <span className="td-listrow__main"><strong>{l.name}</strong><small>{sub}{d.muted.has(l.id) ? " · muted" : ""}</small></span>
      {badge}<span aria-hidden="true" className="muted">›</span>
    </Link>
  );
}

/* ── A list ── */

export function ListPage() {
  const { id } = useParams();
  const { user } = useCtx();
  const d = useTodos();
  const m = useMutate();
  const [open, setOpen] = useState<TItem | null>(null);
  const [menu, setMenu] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [text, setText] = useState("");
  const [undo, setUndo] = useState<Undo | null>(null);
  const tick = useTick(setUndo);
  if (!d) return <><Header title="" back="/m/todos" /><main className="page"><div className="h-skeleton" style={{ height: 200 }} /></main></>;
  const l = d.lists.find((x) => x.id === id);
  if (!l) return <><Header title="List not found" back="/m/todos" /><main className="page"><p className="muted">This list was deleted. <Link to="/m/todos">Back to Tasks</Link></p></main></>;
  const its = d.items.filter((i) => i.list_id === l.id);
  const byPos = (a: TItem, b: TItem) => (a.position ?? 0) - (b.position ?? 0);

  async function add() {
    const title = text.trim(); if (!title) return;
    setText("");
    await m.item(newId(), { list_id: l!.id, title, position: Math.max(0, ...its.map((i) => i.position ?? 0)) + 1, created_by: user.id, created_at: Date.now() });
  }

  const title = `${l.emoji ? `${l.emoji} ` : ""}${l.name}`;
  const menuBtn = <button type="button" className="h-icon-btn" aria-label="List options" onClick={() => setMenu(true)}>{Icon.more}</button>;
  let body: ReactNode;
  if (l.checklist) {
    const items = its.slice().sort(byPos); const c = items.filter((i) => i.checked).length;
    body = (<>
      <div className="td-sec"><h2>{c} of {items.length} ticked</h2>
        <button type="button" className="linklike" disabled={!c} onClick={() => { const was = items.filter((i) => i.checked).map((i) => i.id); for (const i of items) if (i.checked) void m.item(i.id, { checked: 0 }); setUndo({ text: "Unchecked everything, ready for next time", undo: () => was.forEach((x) => void m.item(x, { checked: 1 })) }); }}>Uncheck all</button></div>
      {items.length ? <div className="h-card td-card">{items.map((i) => <ItemRow key={i.id} i={i} list={l} onTick={() => tick(i, l)} onOpen={() => setOpen(i)} />)}</div> : <div className="h-card td-empty">Add the things you always need.</div>}
    </>);
  } else {
    const openItems = its.filter((i) => !i.done_at).sort((a, b) => (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) || (a.due_date ?? "").localeCompare(b.due_date ?? "") || (a.due_time ?? "99").localeCompare(b.due_time ?? "99") || byPos(a, b));
    const done = its.filter((i) => visibleDone(i)).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));
    body = (<>
      {openItems.length ? <div className="h-card td-card">{openItems.map((i) => <ItemRow key={i.id} i={i} list={l} onTick={() => tick(i, l)} onOpen={() => setOpen(i)} />)}</div> : <div className="h-card td-empty">{done.length ? "All done. Nice." : "Nothing here yet. Add a task below."}</div>}
      {done.length > 0 && (
        <div>
          <div className="td-donehead">
            <button type="button" className="linklike" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? "▾" : "▸"} Done · {done.length}</button>
            {showDone && <button type="button" className="linklike" onClick={() => { for (const i of done) void m.item(i.id, { deleted: 1 }); setUndo({ text: "Cleared", undo: () => done.forEach((i) => void m.item(i.id, { deleted: 0 })) }); }}>Clear done</button>}
          </div>
          {showDone && <><div className="h-card td-card">{done.map((i) => <ItemRow key={i.id} i={i} list={l} onTick={() => tick(i, l)} onOpen={() => setOpen(i)} />)}</div><p className="muted td-note">Done items disappear 7 days after they’re ticked.</p></>}
        </div>
      )}
    </>);
  }

  return (<>
    <Header title={title} back="/m/todos" right={menuBtn} />
    <main className="page h-stack mod-main">
      {body}
      <form className="td-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="h-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={l.checklist ? "Add an item" : "Add a task"} aria-label={l.checklist ? "New item" : "New task"} maxLength={200} />
        <Button type="submit" disabled={!text.trim()}>Add</Button>
      </form>
    </main>
    {open && <ItemSheet item={open} list={l} onClose={() => setOpen(null)} setUndo={setUndo} />}
    {menu && <ListMenu list={l} items={its} muted={d.muted.has(l.id)} onClose={() => setMenu(false)} setUndo={setUndo} />}
    {undo && <Toast t={undo} onDone={() => setUndo(null)} />}
  </>);
}
