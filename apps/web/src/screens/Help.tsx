import { Button, Field } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { BackHeader } from "../components/ModuleHeader";
import { useSession } from "../session";

interface Item { id: string; kind: string; first: string; label: string; user_unread: number; updated_at: number }
const KINDS = [["broken", "Something’s broken", "Tell us what you did and what you expected"], ["idea", "Idea", "What would make Haven better for your household?"], ["question", "Question", "Ask anything"]] as const;
const FAQ = [
  ["How do grocery runs work?", "A grocery run is one trip to the shop. In Lists, tap ‘+ Plan a grocery run’, pick the day you’ll shop and tick the meals to buy for. Its list builds itself from those meals, plus any extra items you add."],
  ["Why does a meal say “No grocery run yet”?", "It isn’t on any grocery run, so its ingredients aren’t on a list. Tap ‘No grocery run yet ›’ on the meal to add it to a run, or plan a new run from Lists."],
  ["Does Haven work without signal?", "Yes. Lists, recipes and the plan are kept on your phone; changes sync when you’re back online."],
  ["How do I install Haven?", "Settings › Install Haven on this device shows the steps for your phone or computer."],
];
const day = (t: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(t);

export function Help() {
  const { refresh, status } = useSession();
  const [items, setItems] = useState<Item[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("broken");
  const [text, setText] = useState("");
  const [device, setDevice] = useState(true);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api<{ items: Item[] }>("/api/feedback").then((r) => setItems(r.items)).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  async function send() {
    if (!text.trim()) { setError("Write a few words first"); return; }
    const info = device ? { app: __APP_VERSION__, ua: navigator.userAgent, installed: matchMedia("(display-mode: standalone)").matches, sync: status.state, pending: status.pending } : null;
    try { await api("/api/feedback", { method: "POST", body: JSON.stringify({ kind, text, device: info }) }); setSent(true); setText(""); void load(); void refresh(); }
    catch { setError("Couldn’t send. Check your connection and try again."); }
  }

  return (<>
    <BackHeader title="Help and feedback" back="/settings" />
    <main className="page h-stack" style={{ gap: 20, paddingBottom: 40 }}>
      {items.length > 0 && <section className="h-stack" aria-labelledby="msgs"><h2 id="msgs" className="h-section-title">Your messages</h2>
        {items.map((i) => <Link key={i.id} to={`/help/${i.id}`} className="h-row">{i.user_unread ? <span className="dot inline" aria-label="New reply" /> : <span style={{ width: 9 }} />}
          <span className="h-row__main"><span className="h-row__title" style={{ fontWeight: i.user_unread ? 700 : 600 }}>{i.first}</span><span className="h-row__sub">{day(i.updated_at)} · {i.label}</span></span></Link>)}</section>}
      <section className="h-stack" aria-labelledby="faq"><h2 id="faq" className="h-section-title">Quick answers</h2>
        {FAQ.map(([q, a]) => <details key={q} className="h-card faq"><summary>{q}</summary><p>{a}</p></details>)}</section>
      <section className="h-stack" aria-labelledby="fb"><h2 id="fb" className="h-section-title">Send feedback</h2>
        <div role="radiogroup" aria-label="Kind of feedback" className="chips">{KINDS.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className="h-chip" onClick={() => setKind(k)}>{l}</button>)}</div>
        <Field label="What happened?" textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); setError(undefined); setSent(false); }} placeholder={KINDS.find((k) => k[0] === kind)![2]} error={error} />
        <label className="chips" style={{ alignItems: "flex-start" }}><input type="checkbox" checked={device} onChange={(e) => setDevice(e.target.checked)} style={{ width: 22, height: 22 }} />
          <span><strong>Include device details</strong><br /><span className="muted" style={{ fontSize: 12 }}>App version, device and browser, sync status. No recipes or lists.</span></span></label>
        {sent ? <p role="status" className="note note--info">Thanks, sent. You’ll see any reply under Your messages.</p> : <Button onClick={send}>Send</Button>}
      </section>
    </main>
  </>);
}

export function Thread() {
  const { id } = useParams();
  const { refresh } = useSession();
  const nav = useNavigate();
  const [t, setT] = useState<{ label: string; kind: string; created_at: number; messages: { id: string; author: string; text: string; created_at: number }[] } | null>(null);
  const [text, setText] = useState("");
  const load = () => api<typeof t>(`/api/feedback/${id}`).then((r) => { setT(r); void refresh(); }).catch(() => nav("/help"));
  useEffect(() => { void load(); }, [id]);
  if (!t) return null;
  const when = (x: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(x);
  return (<>
    <BackHeader title="Your message" back="/help" right={<span className="h-badge badge--neutral" style={{ marginRight: 8 }}>{t.label}</span>} />
    <main className="page h-stack" style={{ paddingBottom: 110 }}>
      <span className="muted center-text" style={{ fontSize: 12 }}>{KINDS.find((k) => k[0] === t.kind)?.[1]} · {day(t.created_at)} · Only you can see this conversation</span>
      {t.messages.map((m) => <div key={m.id} className={`bubble ${m.author === "user" ? "bubble--me" : ""}`}><strong>{m.author === "user" ? "You" : "Haven team"} · {when(m.created_at)}</strong><span>{m.text}</span></div>)}
    </main>
    <form className="add-bar" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; await api(`/api/feedback/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }); setText(""); void load(); }}>
      <label className="h-sr" htmlFor="reply">Reply</label><input id="reply" className="h-input" placeholder="Reply to the Haven team" value={text} onChange={(e) => setText(e.target.value)} />
      <Button type="submit">Send</Button>
    </form>
  </>);
}
