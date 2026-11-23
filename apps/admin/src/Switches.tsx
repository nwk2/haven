import { startRegistration } from "@simplewebauthn/browser";
import { Announcement, announcementKindIcon, announcementKindName, Button, Field, Segmented, Switch, type AnnouncementKind } from "@haven/ui";
import { useEffect, useState } from "react";
import { api, when } from "./api";
import { InstallCard } from "./install";
import { deviceName } from "./SignIn";

const FLAGS: Record<string, [string, string]> = {
  show_planned_modules: ["Show planned modules", "Console tiles for future modules (not tappable)"],
  module_meals_enabled: ["Meals & Groceries module", "Emergency off switch for every household; data is kept"],
  module_todos_enabled: ["Tasks module", "Lets households turn on Tasks (Settings › Modules); off stops reminders and hides it; data is kept"],
  offer_install: ["Offer install after sign-in", "Install card on the home screen, with steps for this device"],
};
const ACTION_TARGET = (t: string, id: string | null) => (id ? `${t} · ${id}` : t);

export function Switches() {
  const [flags, setFlags] = useState<{ key: string; value: boolean }[]>([]);
  const [ann, setAnn] = useState<Ann[]>([]);
  const [audit, setAudit] = useState<{ at: number; action: string; target_type: string; target_id: string | null }[]>([]);
  const load = () => { api<{ flags: typeof flags; announcements: typeof ann }>("/flags").then((r) => { setFlags(r.flags); setAnn(r.announcements); }); api<{ items: typeof audit }>("/audit").then((r) => setAudit(r.items)); };
  useEffect(load, []);
  return (
    <div className="h-stack" style={{ gap: 18 }}>
      <h1>Switches and audit log</h1>
      <section className="h-card" style={{ padding: "4px 16px" }}>{flags.map((f) => (
        <div key={f.key} className="spread flag"><span><strong>{FLAGS[f.key]?.[0] ?? f.key}</strong><br /><span className="muted" style={{ fontSize: 12 }}>{FLAGS[f.key]?.[1]}</span></span>
          <Switch label={FLAGS[f.key]?.[0] ?? f.key} checked={f.value} onChange={async (v) => { await api(`/flags/${f.key}`, { method: "PUT", body: JSON.stringify({ value: v }) }); load(); }} /></div>))}</section>
      <AnnouncementsAdmin list={ann} onChanged={load} setList={setAnn} />
      <section className="h-card" style={{ overflowX: "auto" }}>
        <table className="audit"><caption>Audit log</caption><thead><tr><th>When</th><th>Action</th><th>Target</th></tr></thead>
          <tbody>{audit.map((a, i) => <tr key={i}><td>{when(a.at)}</td><td>{a.action}</td><td className="muted">{ACTION_TARGET(a.target_type, a.target_id)}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}

export function Account() {
  const [me, setMe] = useState<{ email: string; expiresAt: number } | null>(null);
  const [theme, setTheme] = useState(() => JSON.parse(localStorage.getItem("haven-admin:theme") ?? '{"theme":"night","mode":"system"}') as { theme: string; mode: string });
  const [msg, setMsg] = useState<string>();
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  useEffect(() => { api<typeof me>("/me").then(setMe); }, []);
  useEffect(() => { localStorage.setItem("haven-admin:theme", JSON.stringify(theme)); document.documentElement.dataset.theme = theme.theme; document.documentElement.dataset.mode = theme.mode; }, [theme]);
  return (
    <div className="h-stack" style={{ gap: 18 }}>
      <h1>Account and appearance</h1>
      <section className="h-stack"><h2 className="h-section-title">Appearance</h2>
        <Segmented label="Theme" value={theme.theme} onChange={(v) => setTheme({ ...theme, theme: v })} options={[{ value: "market", label: "Market Green" }, { value: "tomato", label: "Tomato & Ink" }, { value: "night", label: "Night Utility" }]} />
        <Segmented label="Mode" value={theme.mode} onChange={(v) => setTheme({ ...theme, mode: v })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <span className="muted" style={{ fontSize: 12 }}>Saved on this device only. The Admin badge stays whatever you pick.</span></section>
      <InstallCard />
      <section className="h-card h-stack" style={{ padding: 14 }}>
        <strong>Sign in on another device</strong>
        <span className="muted" style={{ fontSize: 12 }}>Each browser keeps its own sign-in, so opening admin somewhere new asks for Google again. A one-time code skips the Google step there — you’ll still confirm with your passkey.</span>
        {code && <><span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>{code.code}</span>
          <span className="muted" style={{ fontSize: 12 }}>Single use · expires {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(code.expiresAt)} · making a new code retires this one</span>
          <Button variant="secondary" onClick={async () => { await navigator.clipboard.writeText(code.code.replace("-", "")); setMsg("Code copied."); }}>Copy code</Button></>}
        <Button variant="secondary" loading={codeBusy} onClick={async () => {
          setCodeBusy(true);
          try { setCode(await api<{ code: string; expiresAt: number }>("/signin-codes", { method: "POST" })); setMsg(undefined); }
          catch { setMsg("Couldn’t make a code. Confirm with your passkey and try again."); }
          finally { setCodeBusy(false); }
        }}>{code ? "Make a new code" : "Get a sign-in code"}</Button>
        {msg && <p role="status" className="note">{msg}</p>}
      </section>
      <section className="h-card h-stack" style={{ padding: 14 }}>
        <strong>{me?.email}</strong><span className="muted" style={{ fontSize: 12 }}>Admin · Google + passkey · session ends {me ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(me.expiresAt) : ""}</span>
        {msg && <p role="status" className="note">{msg}</p>}
        <Button variant="secondary" onClick={async () => {
          try { const r = await api<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/passkey/options?add=1"); const response = await startRegistration({ optionsJSON: r.options });
            await api("/passkey/register", { method: "POST", body: JSON.stringify({ response, name: deviceName() }) }); setMsg("Passkey added."); }
          catch { setMsg("Couldn’t add a passkey."); }
        }}>Add a passkey on this device</Button>
        <Button variant="secondary" className="quiet-danger" onClick={async () => { await api("/signout", { method: "POST" }); location.href = "/sign-in"; }}>Sign out of admin</Button>
      </section>
    </div>
  );
}

/* ── Announcements (decision, Nov 2026): typed, titled, optionally dismissible, live preview ── */
interface Ann { id: string; kind: AnnouncementKind; title: string | null; text: string; dismissible: number; starts_at: number; ends_at: number; dismissed: number }
interface Form { id: string | null; kind: AnnouncementKind; title: string; text: string; dismissible: boolean; from: string; until: string; dismissed: number; showAgain: boolean }
const toLocal = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const blank = (): Form => { const now = Date.now(); return { id: null, kind: "info", title: "", text: "", dismissible: true, from: toLocal(now), until: toLocal(now + 7 * 86_400_000), dismissed: 0, showAgain: false }; };
const status = (a: Ann) => (a.ends_at <= Date.now() ? "Ended" : a.starts_at > Date.now() ? "Scheduled" : "Live");

function AnnouncementsAdmin({ list, onChanged, setList }: { list: Ann[]; onChanged: () => void; setList: (u: (prev: Ann[]) => Ann[]) => void }) {
  const [f, setF] = useState<Form>(blank);
  const [busy, setBusy] = useState(false);
  // Heads-up (maintenance, outages) defaults to "can't be dismissed" on a new announcement, until you flip
  // the switch yourself (decision, Nov 2026). Editing an existing one never changes it.
  const [touched, setTouched] = useState(false);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const pickKind = (k: AnnouncementKind) => set(!f.id && !touched ? { kind: k, dismissible: k !== "warn" } : { kind: k });
  const edit = (a: Ann) => { setTouched(false); setF({ id: a.id, kind: a.kind, title: a.title ?? "", text: a.text, dismissible: !!a.dismissible, from: toLocal(a.starts_at), until: toLocal(a.ends_at), dismissed: a.dismissed, showAgain: false }); };
  const valid = f.text.trim() && f.from && f.until && new Date(f.until) > new Date(f.from);
  async function save() {
    setBusy(true);
    const starts_at = new Date(f.from).getTime();
    const ends_at = new Date(f.until).getTime();
    const body = JSON.stringify({ kind: f.kind, title: f.title.trim() || null, text: f.text, dismissible: f.dismissible, starts_at, ends_at, show_again: f.showAgain });
    const r = await (f.id
      ? api<{ ok: true }>(`/announcements/${f.id}`, { method: "PUT", body })
      : api<{ id: string }>("/announcements", { method: "POST", body })).finally(() => setBusy(false));
    // Optimistic insert: show the saved row immediately (same shape as the server row —
    // title/text trimmed and sliced as row() does, dismissed kept unless "show again"
    // cleared it). onChanged() still runs for reconciliation; the refetch replaces the
    // whole list, so a later successful refetch cannot duplicate the row.
    const saved: Ann = { id: f.id ?? (r as { id: string }).id, kind: f.kind, title: f.title.trim().slice(0, 60) || null, text: f.text.trim().slice(0, 280), dismissible: f.dismissible ? 1 : 0, starts_at, ends_at, dismissed: f.id ? (f.showAgain ? 0 : f.dismissed) : 0 };
    setList((prev) => (f.id ? prev.map((a) => (a.id === f.id ? saved : a)) : [...prev, saved]).sort((a, b) => b.starts_at - a.starts_at));
    setF(blank()); setTouched(false); onChanged();
  }
  return (
    <>
      <section className="h-card h-stack" style={{ padding: 16 }} aria-labelledby="ann-h">
        <h2 id="ann-h" style={{ margin: 0, fontSize: 16 }}>Announcements</h2>
        {!list.length && <p className="muted" style={{ margin: 0, fontSize: 13 }}>None yet. They show at the top of everyone’s console.</p>}
        {list.map((a) => (
          <button key={a.id} type="button" className="ann-row" aria-current={f.id === a.id ? "true" : undefined} onClick={() => edit(a)}>
            <span className={`ann-dot ann-dot--${a.kind}`} aria-hidden="true" />
            <span className="ann-row__main"><span>{a.title || a.text}</span>
              <small>{announcementKindName(a.kind)} · {when(a.starts_at)} → {when(a.ends_at)}{a.dismissible ? (a.dismissed ? ` · dismissed by ${a.dismissed}` : "") : " · can’t be dismissed"}</small></span>
            <span className={`ann-status ann-status--${status(a).toLowerCase()}`}>{status(a)}</span>
          </button>
        ))}
        {f.id && <Button variant="text" onClick={() => { setF(blank()); setTouched(false); }}>+ New announcement</Button>}
      </section>
      <section className="h-card h-stack" style={{ padding: 16 }} aria-labelledby="ann-form-h">
        <h2 id="ann-form-h" style={{ margin: 0, fontSize: 16 }}>{f.id ? "Edit announcement" : "New announcement"}</h2>
        <div><span className="h-field__label">Type</span>
          <div className="kind-seg" role="radiogroup" aria-label="Type">{(["info", "warn", "ok"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={`kind-seg--${k}`} onClick={() => pickKind(k)}>{announcementKindIcon(k)}<span>{announcementKindName(k)}</span></button>))}</div></div>
        <Field label="Title (optional)" value={f.title} maxLength={60} placeholder="e.g. Planned maintenance" onChange={(e) => set({ title: e.target.value })} />
        <Field label="Message" textarea value={f.text} maxLength={280} placeholder="What people need to know, in a sentence or two" onChange={(e) => set({ text: e.target.value })} />
        <div className="two-col"><Field label="Show from" type="datetime-local" value={f.from} onChange={(e) => set({ from: e.target.value })} /><Field label="Until" type="datetime-local" value={f.until} onChange={(e) => set({ until: e.target.value })} /></div>
        <div className="spread flag" style={{ borderTop: 0 }}><span><strong>People can dismiss it</strong><br /><span className="muted" style={{ fontSize: 12 }}>Turn off for things everyone must see, like maintenance in progress. It then stays until its end time.</span></span>
          <Switch label="People can dismiss it" checked={f.dismissible} onChange={(v) => { setTouched(true); set({ dismissible: v }); }} /></div>
        {f.id && f.dismissed > 0 && (
          <div className="spread flag" style={{ borderTop: 0 }}><span><strong>Show it again to people who dismissed it</strong><br /><span className="muted" style={{ fontSize: 12 }}>{f.dismissed === 1 ? "1 person has" : `${f.dismissed} people have`} dismissed it. Use this for changes that matter, like a new time; leave it off for typo fixes.</span></span>
            <Switch label="Show it again to people who dismissed it" checked={f.showAgain} onChange={(v) => set({ showAgain: v })} /></div>
        )}
        <span className="h-field__label">Preview on the console</span>
        <div className="ann-preview"><Announcement preview a={{ id: "preview", kind: f.kind, title: f.title.trim() || null, text: f.text, dismissible: f.dismissible, ends_at: f.until ? new Date(f.until).getTime() : Date.now() }} /></div>
        <div className="h-stack">
          <Button disabled={!valid} loading={busy} onClick={save}>{f.id ? "Save changes" : "Schedule announcement"}</Button>
          {f.id && <Button variant="secondary" className="quiet-danger" onClick={async () => { const id = f.id; await api(`/announcements/${id}`, { method: "DELETE" }); setList((prev) => prev.filter((a) => a.id !== id)); setF(blank()); setTouched(false); onChanged(); }}>Remove announcement</Button>}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>Open Haven apps update within a few seconds of saving.</span>
      </section>
    </>
  );
}
