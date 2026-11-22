import { Button, Dialog, Field } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, day } from "./api";
import { Empty } from "./bits";

interface U { id: string; name: string; email: string; household: string | null; role: string | null; last_seen: number | null; suspended_at: number | null }

export function Users() {
  const { id } = useParams();
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<U[]>([]);
  useEffect(() => { const t = setTimeout(() => api<{ users: U[] }>(`/users?q=${encodeURIComponent(q)}`).then((r) => setUsers(r.users)).catch(() => undefined), 250); return () => clearTimeout(t); }, [q]);
  return (
    <div className={`split${id ? " split--detail" : ""}`}>
      <section className="split__list h-stack">
        <h1>Users</h1>
        <p className="muted" style={{ margin: 0 }}>Account details only; household recipes, plans and lists are never shown here.</p>
        <label className="h-field"><span className="h-sr">Search users by email</span><input className="h-input" type="search" placeholder="Search by email or name" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        {q.trim() && !users.length && <Empty title={`No accounts match “${q.trim()}”`} body="Search looks at email addresses and names." />}
        {users.map((u) => <Link key={u.id} to={`/users/${u.id}`} className="h-row" aria-current={id === u.id ? "true" : undefined}><span className="h-row__main"><span className="h-row__title">{u.name}</span><span className="h-row__sub">{u.email} · {u.household ?? "No household"}{u.role ? ` · ${u.role === "owner" ? "Owner" : "Member"}` : ""}</span></span>{u.suspended_at ? <span className="h-badge kind-broken">Suspended</span> : null}</Link>)}
      </section>
      {id && <Account id={id} />}
    </div>
  );
}

function Account({ id }: { id: string }) {
  const [u, setU] = useState<Record<string, unknown> & { counts: Record<string, number> | null; others: { id: string; name: string }[] } | null>(null);
  const [confirm, setConfirm] = useState<null | "suspend" | "delete" | "transfer">(null);
  const [to, setTo] = useState<string>("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string>();
  const load = () => api<NonNullable<typeof u>>(`/users/${id}`).then(setU).catch(() => setU(null));
  useEffect(() => { void load(); setMsg(undefined); }, [id]);
  if (!u) return <section className="split__detail" />;
  const act = async (action: string, body: object = {}) => {
    try { await api(`/users/${id}/${action}`, { method: "POST", body: JSON.stringify(body) }); setMsg("Done. Recorded in the audit log."); setConfirm(null); await load(); }
    catch (e) { setMsg(e instanceof Error ? `That didn’t work (${e.message}).` : "That didn’t work."); }
  };
  const owner = u.role === "owner";
  return (
    <section className="split__detail h-stack">
      <Link className="h-btn h-btn--text only-phone" to="/users">← Users</Link>
      <h2 style={{ margin: 0 }}>{String(u.name)}</h2>
      <span className="muted">{String(u.email)}{u.household ? ` · ${owner ? "Owner" : "Member"} of ${u.household}` : ""}{u.suspended_at ? " · Suspended" : ""}</span>
      <dl className="facts">
        <dt>Joined</dt><dd>{day(Number(u.created_at))}</dd>
        <dt>Last active</dt><dd>{u.last_seen ? day(Number(u.last_seen)) : "—"}</dd>
        <dt>Signed-in devices</dt><dd>{String(u.devices)}</dd>
        {u.counts && <><dt>Household</dt><dd>{String(u.household)} · {u.counts.members} members · {String(u.timezone)} · {String(u.measurement)}</dd>
          <dt>Household size</dt><dd>{u.counts.recipes} recipes · {u.counts.trips} grocery runs (counts only)</dd></>}
        <dt>Feedback</dt><dd>{String(u.feedback)} conversations</dd>
      </dl>
      {msg && <p role="status" className="note">{msg}</p>}
      <div className="actions">
        <button className="h-row act" onClick={() => act("signout")}><span className="h-row__main"><span className="h-row__title">Sign out everywhere</span><span className="h-row__sub">Ends all {String(u.devices)} sessions</span></span></button>
        <a className="h-row act" href={`/api/users/${id}/export`}><span className="h-row__main"><span className="h-row__title">Export data</span><span className="h-row__sub">Same file as Settings › Export my data</span></span></a>
        {owner && u.others.length > 0 && <button className="h-row act" onClick={() => { setTo(u.others[0].id); setConfirm("transfer"); }}><span className="h-row__main"><span className="h-row__title">Transfer ownership</span><span className="h-row__sub">Make another member Owner</span></span></button>}
        {u.suspended_at ? <button className="h-row act" onClick={() => act("unsuspend")}><span className="h-row__main"><span className="h-row__title">Lift suspension</span></span></button>
          : <button className="h-row act danger" onClick={() => setConfirm("suspend")}><span className="h-row__main"><span className="h-row__title">Suspend account</span><span className="h-row__sub">Signs out and blocks sign-in until lifted</span></span></button>}
        {u.deleted_at ? <button className="h-row act" onClick={() => act("restore")}><span className="h-row__main"><span className="h-row__title">Restore household</span><span className="h-row__sub">Deleted {day(Number(u.deleted_at))}</span></span></button> : null}
        <button className="h-row act danger" onClick={() => setConfirm("delete")}><span className="h-row__main"><span className="h-row__title">Delete account</span><span className="h-row__sub">For deletion requests; asks for your passkey</span></span></button>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>Every action is recorded in the audit log. Destructive actions ask for your passkey again if you haven’t used it in the last 15 minutes.</span>
      {confirm === "suspend" && <Dialog title={`Suspend ${u.name}?`} body="They’re signed out everywhere and can’t sign in until you lift it. Their household’s data isn’t changed." onClose={() => setConfirm(null)}>
        <Field label="Reason (only you see this)" value={reason} onChange={(e) => setReason(e.target.value)} /><Button variant="danger" onClick={() => act("suspend", { reason })}>Suspend</Button><Button variant="text" onClick={() => setConfirm(null)}>Cancel</Button></Dialog>}
      {confirm === "delete" && <Dialog title={`Delete ${u.name}’s account?`} body={u.counts && u.counts.members <= 1 ? `They’re the only member, so ${u.household} and everything in it is deleted too. This can’t be undone.` : "Their profile is erased; their household keeps its data. This can’t be undone."} onClose={() => setConfirm(null)}>
        <Button variant="danger" onClick={() => act("delete")}>Delete account</Button><Button variant="text" onClick={() => setConfirm(null)}>Cancel</Button></Dialog>}
      {confirm === "transfer" && <Dialog title="Transfer ownership" body={`Choose the new Owner of ${u.household}.`} onClose={() => setConfirm(null)}>
        <div className="chips" role="radiogroup">{u.others.map((o) => <button key={o.id} role="radio" aria-checked={to === o.id} className="h-chip" onClick={() => setTo(o.id)}>{o.name}</button>)}</div>
        <Button onClick={() => act("transfer", { to })}>Make Owner</Button><Button variant="text" onClick={() => setConfirm(null)}>Cancel</Button></Dialog>}
    </section>
  );
}
