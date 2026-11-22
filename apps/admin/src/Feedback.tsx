import { Button } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, day, when } from "./api";

interface Row { id: string; kind: string; status: string; name: string | null; email: string | null; first: string; updated_at: number }
const STATUSES = [["new", "New"], ["in_progress", "In progress"], ["replied", "Replied"], ["done", "Done"]] as const;
const KIND: Record<string, string> = { broken: "Broken", idea: "Idea", question: "Question" };

export function Feedback() {
  const { id } = useParams();
  const [status, setStatus] = useState<string>("new");
  const [data, setData] = useState<{ items: Row[]; counts: Record<string, number> }>({ items: [], counts: {} });
  const load = () => api<typeof data>(`/feedback?status=${status}`).then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, [status]);
  return (
    <div className={`split${id ? " split--detail" : ""}`}>
      <section className="split__list h-stack" aria-label="Inbox">
        <h1>Feedback</h1>
        <div className="chips" role="group" aria-label="Status filter">{STATUSES.map(([k, l]) => <button key={k} className="h-chip" aria-pressed={status === k} onClick={() => setStatus(k)}>{l} {data.counts[k] ?? 0}</button>)}</div>
        {!data.items.length && <p className="muted">Nothing here.</p>}
        {data.items.map((r) => (
          <Link key={r.id} to={`/feedback/${r.id}`} className="h-row inbox-row" aria-current={id === r.id ? "true" : undefined}>
            <span className="h-row__main"><span className="chips"><span className={`h-badge kind-${r.kind}`}>{KIND[r.kind]}</span><span className="muted" style={{ fontSize: 12 }}>{r.name ?? "Deleted account"} · {day(r.updated_at)}</span></span>
              <span className="h-row__title">{r.first}</span></span>
          </Link>
        ))}
      </section>
      {id && <Conversation id={id} onChange={load} />}
    </div>
  );
}

function Conversation({ id, onChange }: { id: string; onChange: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState<Record<string, unknown> & { messages: { id: string; author: string; text: string; created_at: number }[] } | null>(null);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const load = () => api<NonNullable<typeof f>>(`/feedback/${id}`).then((x) => { setF(x); setNote(String(x.admin_note ?? "")); });
  useEffect(() => { void load(); }, [id]);
  if (!f) return <section className="split__detail" />;
  const device = f.device ? JSON.parse(String(f.device)) as Record<string, unknown> : null;
  const post = async (body: object) => { await api(`/feedback/${id}`, { method: "POST", body: JSON.stringify(body) }); await load(); onChange(); };
  return (
    <section className="split__detail h-stack" aria-label="Conversation">
      <div className="spread"><button className="h-btn h-btn--text only-phone" onClick={() => nav("/feedback")}>← Inbox</button></div>
      <h2 style={{ margin: 0 }}>{f.messages[0]?.text.slice(0, 80)}</h2>
      <span className="muted">{String(f.name ?? "Deleted account")} · {String(f.email ?? "")} {f.household ? `· ${f.role === "owner" ? "Owner" : "Member"} of ${f.household} (${f.members} members)` : ""} {f.user_id ? <Link to={`/users/${f.user_id}`}>View account</Link> : null}</span>
      <div className="chips" role="group" aria-label="Status">{STATUSES.map(([k, l]) => <button key={k} className="h-chip" aria-pressed={f.status === k} onClick={() => post({ status: k })}>{l}</button>)}</div>
      <details className="h-card" style={{ padding: "0 12px" }}><summary style={{ minHeight: 40, display: "flex", alignItems: "center", cursor: "pointer" }}>Device details and note</summary>
        <p className="muted" style={{ fontSize: 12 }}>{device ? Object.entries(device).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") : "No device details shared."}</p>
        <label className="h-field" style={{ marginBottom: 12 }}><span className="h-field__label">Internal note (only you see this)</span><input className="h-input" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => post({ note })} /></label></details>
      {f.messages.map((m) => <div key={m.id} className={`bubble${m.author === "admin" ? " bubble--me" : ""}`}><strong>{m.author === "admin" ? "You" : String(f.name ?? "User")} · {when(m.created_at)}</strong><span>{m.text}</span></div>)}
      {f.user_id ? (
        <form className="h-stack reply" onSubmit={async (e) => { e.preventDefault(); if (reply.trim()) { await post({ reply }); setReply(""); } }}>
          <label className="h-field"><span className="h-field__label">Reply to {String(f.name)} (shows in their Help and feedback)</span><textarea className="h-input" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} /></label>
          <Button type="submit" disabled={!reply.trim()}>Send reply</Button>
        </form>
      ) : <p className="muted">This account was deleted, so replies can’t be delivered.</p>}
    </section>
  );
}
