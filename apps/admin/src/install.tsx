import { Button } from "@haven/ui";
import { useEffect, useState } from "react";

/** The browser's own install prompt (Chrome, Edge, Android), captured as early as possible. */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallPrompt | null = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallPrompt; });

const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Firefox/.test(ua) && !/Android/.test(ua)) return "firefox-desktop";
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua)) return "mac-safari";
  return "other";
}

/** Account › "Install on this device" (decision, Nov 2026: admin is installable, nothing cached). */
export function InstallCard() {
  const [canPrompt, setCanPrompt] = useState(!!deferred);
  const [done, setDone] = useState(false);
  useEffect(() => { const t = setInterval(() => setCanPrompt(!!deferred), 500); return () => clearInterval(t); }, []);
  if (standalone() || done) return null;
  const p = platform();
  return (
    <section className="h-card h-stack" style={{ padding: 14 }} aria-labelledby="install-h">
      <h2 id="install-h" style={{ margin: 0, fontSize: 16 }}>Install on this device</h2>
      <span className="muted" style={{ fontSize: 13 }}>Opens full screen from its own icon. Nothing is saved on the device; it needs a connection.</span>
      {canPrompt && <Button onClick={async () => { await deferred?.prompt(); const r = await deferred?.userChoice; deferred = null; if (r?.outcome === "accepted") setDone(true); }}>Install</Button>}
      {!canPrompt && p === "ios" && <ol className="steps-ol"><li>Tap <strong>Share</strong> in Safari’s toolbar</li><li>Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong></li></ol>}
      {!canPrompt && p === "mac-safari" && <span style={{ fontSize: 13 }}>In Safari’s menu bar: <strong>File › Add to Dock</strong>.</span>}
      {!canPrompt && p === "firefox-desktop" && <span style={{ fontSize: 13 }}>Firefox on computers can’t install web apps. Open admin in Chrome, Edge or Safari to install it.</span>}
      {!canPrompt && p === "other" && <span style={{ fontSize: 13 }}>Use your browser’s <strong>Install app</strong> option (the install icon in the address bar, or the browser menu).</span>}
      {p === "ios" && <span className="muted" style={{ fontSize: 12 }}>On iPhone the installed app keeps its own sign-in, so you’ll sign in with Google and your passkey once more inside it.</span>}
    </section>
  );
}
