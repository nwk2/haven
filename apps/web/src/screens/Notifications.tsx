import { Button, Icon, Switch } from "@haven/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useSession } from "../session";

interface Prefs { enabled: boolean; publicKey: string | null; digest: boolean; given: boolean; devices: number }
type DeviceState = "checking" | "unsupported" | "ios-browser" | "denied" | "off" | "on";

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const keyBytes = (b64u: string) => { const s = b64u.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

/** Settings › Notifications (PRD › To-dos plan › Notifications). */
export function Notifications() {
  const { me, db, sync } = useSession();
  const [p, setP] = useState<Prefs | null>(null);
  const [device, setDevice] = useState<DeviceState>("checking");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<Prefs>("/api/notifications").then(setP);
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setDevice(isIOS() && !standalone() ? "ios-browser" : "unsupported"); return; }
      if (Notification.permission === "denied") { setDevice("denied"); return; }
      const reg = await navigator.serviceWorker.ready;
      setDevice((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setDevice("unsupported"));
  }, []);

  const lists = useLiveQuery(async () => {
    if (!db || !me) return [];
    const [ls, mutes] = await Promise.all([db.todos_lists.filter((l) => !l.deleted).toArray(), db.todos_mutes.filter((m) => !m.deleted && m.user_id === me.user.id).toArray()]);
    const muted = new Set(mutes.map((m) => String(m.list_id)));
    return ls.map((l) => ({ id: l.id, name: String(l.name), emoji: l.emoji as string | null, checklist: !!l.checklist, muted: muted.has(l.id) }));
  }, [db, me?.user.id]);

  async function turnOn() {
    if (!p?.publicKey) return;
    setBusy(true); setMsg(null);
    try {
      const perm = await Notification.requestPermission();   // must follow a tap (iPhone requires it)
      if (perm !== "granted") { setDevice(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(p.publicKey) });
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
      setDevice("on"); void load();
    } catch { setMsg("Couldn’t turn on notifications on this device. Try again."); }
    finally { setBusy(false); }
  }
  async function turnOff() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
      if (sub) { await api("/api/push/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      setDevice("off"); void load();
    } finally { setBusy(false); }
  }
  const setPref = async (k: "digest" | "given", v: boolean) => { setP((x) => x && { ...x, [k]: v }); await api("/api/notifications", { method: "PUT", body: JSON.stringify({ [k]: v }) }); };

  if (!me || !p) return null;
  const on = device === "on";
  return (<>
    <header className="h-header"><Link to="/settings" className="h-icon-btn" aria-label="Back to settings">{Icon.back}</Link><h1 className="h-header__title">Notifications</h1></header>
    <main className="page h-stack">
      {!p.enabled && <p className="note note--info">Notifications aren’t set up for Haven yet. Everything else works; reminders will start once they are.</p>}
      <section className="h-card h-stack" style={{ padding: "4px 16px" }} aria-label="This device">
        <div className="spread flag"><span><strong>On this device</strong><br /><span className="muted" style={{ fontSize: 13 }}>
          {device === "ios-browser" ? "On iPhone and iPad, notifications work in the installed Haven app (iOS 16.4 or later)."
            : device === "denied" ? "Notifications are blocked for Haven. Allow them in your browser or phone settings, then come back."
            : device === "unsupported" ? "This browser can’t show notifications."
            : on ? "This device will get your reminders." : "Your phone asks for permission the first time."}</span></span>
          {(device === "on" || device === "off") && p.enabled && <Switch label="Notifications on this device" checked={on} onChange={(v) => (busy ? undefined : v ? turnOn() : turnOff())} />}</div>
        {device === "ios-browser" && <Link className="h-btn h-btn--secondary" to="/install" style={{ marginBottom: 12 }}>How to install Haven</Link>}
        <div className="spread flag"><span><strong>Morning digest · 10:00</strong><br /><span className="muted" style={{ fontSize: 13 }}>One message with today’s tasks that have no time.</span></span>
          <Switch label="Morning digest" checked={p.digest} onChange={(v) => setPref("digest", v)} /></div>
        <div className="spread flag"><span><strong>When someone gives you a task</strong><br /><span className="muted" style={{ fontSize: 13 }}>“Mira gave you a task: Call the plumber”</span></span>
          <Switch label="When someone gives you a task" checked={p.given} onChange={(v) => setPref("given", v)} /></div>
      </section>
      {on && <Button variant="secondary" loading={busy} onClick={async () => { const r = await api<{ sent: number }>("/api/push/test", { method: "POST" }).catch(() => ({ sent: -1 })); setMsg(r.sent > 0 ? "Sent. It should arrive in a few seconds." : r.sent === 0 ? "Nothing was sent. Try turning this device off and on again." : "Couldn’t send right now. Try again later."); }}>Send a test notification</Button>}
      {msg && <p role="status" className="muted">{msg}</p>}
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Tasks with a time remind you at that time. Ones without an assignee remind everyone who hasn’t muted the list. {p.devices > 0 ? `You get notifications on ${p.devices} device${p.devices === 1 ? "" : "s"}.` : ""}</p>
      {me.flags.module_todos_enabled && (lists?.length ?? 0) > 0 && (
        <section className="h-stack" aria-labelledby="nl"><h2 id="nl" className="h-section-title">Lists</h2>
          <div className="h-card" style={{ padding: "4px 16px" }}>{lists!.filter((l) => !l.checklist).map((l) => (
            <div key={l.id} className="spread flag"><span><strong>{l.emoji ? `${l.emoji} ` : ""}{l.name}</strong><br /><span className="muted" style={{ fontSize: 13 }}>{l.muted ? "Muted for you" : "Reminds you"}</span></span>
              <Switch label={`Reminders from ${l.name}`} checked={!l.muted} onChange={(v) => void sync?.mutate("todos_mutes", `${me.user.id}|${l.id}`, { user_id: me.user.id, list_id: l.id, deleted: v ? 1 : 0 })} /></div>
          ))}</div>
        </section>
      )}
    </main>
  </>);
}
