import { startRegistration } from "@simplewebauthn/browser";
import { Button, Field, Segmented, Switch } from "@haven/ui";
import { useEffect, useState } from "react";
import { api, when } from "./api";
import { deviceName } from "./SignIn";

const FLAGS: Record<string, [string, string]> = {
  show_planned_modules: ["Show planned modules", "Console tiles for future modules (not tappable)"],
  module_meals_enabled: ["Meals & Groceries module", "Emergency off switch for every household; data is kept"],
  offer_install: ["Offer install after first grocery run", "Install banner and guide"],
};
const ACTION_TARGET = (t: string, id: string | null) => (id ? `${t} · ${id}` : t);

export function Switches() {
  const [flags, setFlags] = useState<{ key: string; value: boolean }[]>([]);
  const [ann, setAnn] = useState<{ id: string; text: string; starts_at: number; ends_at: number }[]>([]);
  const [audit, setAudit] = useState<{ at: number; action: string; target_type: string; target_id: string | null }[]>([]);
  const [text, setText] = useState(""); const [from, setFrom] = useState(""); const [until, setUntil] = useState("");
  const load = () => { api<{ flags: typeof flags; announcements: typeof ann }>("/flags").then((r) => { setFlags(r.flags); setAnn(r.announcements); }); api<{ items: typeof audit }>("/audit").then((r) => setAudit(r.items)); };
  useEffect(load, []);
  return (
    <div className="h-stack" style={{ gap: 18 }}>
      <h1>Switches and audit log</h1>
      <section className="h-card" style={{ padding: "4px 16px" }}>{flags.map((f) => (
        <div key={f.key} className="spread flag"><span><strong>{FLAGS[f.key]?.[0] ?? f.key}</strong><br /><span className="muted" style={{ fontSize: 12 }}>{FLAGS[f.key]?.[1]}</span></span>
          <Switch label={FLAGS[f.key]?.[0] ?? f.key} checked={f.value} onChange={async (v) => { await api(`/flags/${f.key}`, { method: "PUT", body: JSON.stringify({ value: v }) }); load(); }} /></div>))}</section>
      <section className="h-card h-stack" style={{ padding: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Announcement banner</h2>
        {ann.map((a) => <div key={a.id} className="spread note note--info"><span>{a.text}<br /><span className="muted" style={{ fontSize: 12 }}>{when(a.starts_at)} – {when(a.ends_at)}</span></span><Button variant="text" onClick={async () => { await api(`/announcements/${a.id}`, { method: "DELETE" }); load(); }}>Remove</Button></div>)}
        <Field label="Message (shown at the top of the console for everyone)" value={text} onChange={(e) => setText(e.target.value)} maxLength={280} />
        <div className="two-col"><Field label="Show from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /><Field label="Until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
        <Button disabled={!text.trim() || !from || !until} onClick={async () => { await api("/announcements", { method: "POST", body: JSON.stringify({ text, starts_at: new Date(from).getTime(), ends_at: new Date(until).getTime() }) }); setText(""); load(); }}>Schedule</Button>
      </section>
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
  useEffect(() => { api<typeof me>("/me").then(setMe); }, []);
  useEffect(() => { localStorage.setItem("haven-admin:theme", JSON.stringify(theme)); document.documentElement.dataset.theme = theme.theme; document.documentElement.dataset.mode = theme.mode; }, [theme]);
  return (
    <div className="h-stack" style={{ gap: 18 }}>
      <h1>Account and appearance</h1>
      <section className="h-stack"><h2 className="h-section-title">Appearance</h2>
        <Segmented label="Theme" value={theme.theme} onChange={(v) => setTheme({ ...theme, theme: v })} options={[{ value: "market", label: "Market Green" }, { value: "tomato", label: "Tomato & Ink" }, { value: "night", label: "Night Utility" }]} />
        <Segmented label="Mode" value={theme.mode} onChange={(v) => setTheme({ ...theme, mode: v })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <span className="muted" style={{ fontSize: 12 }}>Saved on this device only. The Admin badge stays whatever you pick.</span></section>
      <section className="h-card h-stack" style={{ padding: 14 }}>
        <strong>{me?.email}</strong><span className="muted" style={{ fontSize: 12 }}>Admin · Google + passkey · session ends {me ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(me.expiresAt) : ""}</span>
        {msg && <p role="status" className="note">{msg}</p>}
        <Button variant="secondary" onClick={async () => {
          try { const r = await api<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/passkey/options?add=1"); const response = await startRegistration({ optionsJSON: r.options });
            await api("/passkey/register", { method: "POST", body: JSON.stringify({ response, name: deviceName() }) }); setMsg("Passkey added."); }
          catch { setMsg("Couldn’t add a passkey."); }
        }}>Add a passkey on this device</Button>
        <Button variant="danger" onClick={async () => { await api("/signout", { method: "POST" }); location.href = "/sign-in"; }}>Sign out of admin</Button>
      </section>
    </div>
  );
}
