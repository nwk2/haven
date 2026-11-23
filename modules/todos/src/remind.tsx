import { Button } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

/**
 * "Get reminders on this phone" (Nov 2026, like dont-ngiao's prompt): offered on the To-dos home until
 * this device has notifications on, unless they're blocked, push isn't set up, or someone tapped "Not now"
 * on this device. On iPhone in Safari it points to installing Haven first (iOS 16.4+, installed app only).
 */
const DISMISSED = "haven.remindersPrompt";
type State = "hidden" | "offer" | "install";
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const keyBytes = (b64u: string) => { const s = b64u.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const call = (path: string, init: RequestInit = {}) => fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", "x-haven": "1", ...init.headers } });

export function RemindersCard({ onOn }: { onOn: () => void }) {
  const [state, setState] = useState<State>("hidden");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    (async () => {
      try { if (localStorage.getItem(DISMISSED)) return; } catch { /* private mode: just show it */ }
      const r = await call("/api/notifications"); if (!r.ok) return;
      const n = (await r.json()) as { enabled: boolean; publicKey: string | null };
      if (!n.enabled || !n.publicKey) return;
      setKey(n.publicKey);
      if (isIOS() && !standalone()) { setState("install"); return; }
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
      if (Notification.permission === "denied") return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || (await reg.pushManager.getSubscription())) return;
      setState("offer");
    })().catch(() => undefined);
  }, []);

  const dismiss = () => { try { localStorage.setItem(DISMISSED, String(Date.now())); } catch { /* ignore */ } setState("hidden"); };
  async function turnOn() {
    if (!key) return;
    setBusy(true); setErr(false);
    try {
      const perm = await Notification.requestPermission();   // follows the tap, as iPhone requires
      if (perm !== "granted") { setState("hidden"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      const r = await call("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
      if (!r.ok) throw new Error("subscribe");
      setState("hidden"); onOn();
    } catch { setErr(true); } finally { setBusy(false); }
  }

  if (state === "hidden") return null;
  return (
    <section className="h-card td-remind" aria-labelledby="remind-h">
      <h2 id="remind-h">Get reminders on this phone</h2>
      {state === "install"
        ? <p>On iPhone, reminders work in the installed Haven app. Add Haven to your Home Screen, open it from there, then turn them on.</p>
        : <p>Haven can tell you when a to-do is due, and send a 10:00 digest of the day’s to-dos.</p>}
      {err && <p role="alert" className="td-late" style={{ fontWeight: 600 }}>That didn’t work. Try again, or use Settings › Notifications.</p>}
      <div className="td-remind__actions">
        {state === "install" ? <Link className="h-btn h-btn--primary" to="/install">How to install</Link> : <Button loading={busy} onClick={turnOn}>Turn on</Button>}
        <Button variant="text" onClick={dismiss}>Not now</Button>
      </div>
    </section>
  );
}
