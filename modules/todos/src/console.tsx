import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Ctx, useCtx, type ModuleCtx } from "./ctx";
import { useTodos } from "./data";
import { ItemRow, Toast, useTick, type Undo } from "./screens";

const SHOWN = 4;

/** What Tasks puts on the household console: what's due, tickable in place. */
export function ConsoleTasks({ ctx }: { ctx: ModuleCtx }) {
  return <Ctx.Provider value={ctx}><Section /></Ctx.Provider>;
}

function Section() {
  const { user, today } = useCtx();
  const d = useTodos();
  const nav = useNavigate();
  const [undo, setUndo] = useState<Undo | null>(null);
  const tick = useTick(setUndo);
  if (!d || !d.lists.length) return null;
  const listOf = (id: string) => d.lists.find((l) => l.id === id)!;
  // Same order as Tasks › Today: mine first, then oldest due, then by time.
  const due = d.items.filter((i) => !listOf(i.list_id).checklist && !i.done_at && i.due_date && i.due_date <= today)
    .sort((a, b) => Number(b.assignee_id === user.id) - Number(a.assignee_id === user.id) || a.due_date!.localeCompare(b.due_date!) || (a.due_time ?? "99").localeCompare(b.due_time ?? "99"));
  const more = due.length - SHOWN;

  return (
    <section aria-labelledby="c-tasks">
      <div className="c-label"><h2 id="c-tasks">Tasks</h2><Link to="/m/todos">{more > 0 ? `${more} more` : "All tasks"}</Link></div>
      {due.length
        ? <div className="h-card td-card">{due.slice(0, SHOWN).map((i) => <ItemRow key={i.id} i={i} list={listOf(i.list_id)} onTick={() => tick(i, listOf(i.list_id))} onOpen={() => nav(`/m/todos/list/${i.list_id}`)} />)}</div>
        : <div className="h-card td-empty">Nothing due today.</div>}
      {undo && <Toast t={undo} onDone={() => setUndo(null)} />}
    </section>
  );
}
