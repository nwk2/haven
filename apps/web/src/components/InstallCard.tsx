import { Button } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { INSTALL_SHORT, detectInstallPlatform, installPromptAvailable, isStandalone, promptInstall, shouldShowInstallCard } from "../install";
import { useSession } from "../session";

const DISMISSED_KEY = "haven-install-dismissed";

/**
 * Home-screen install card (Console, the screen after sign-in). The admin's
 * offer_install flag turns it on/off; it never shows when the app is already
 * running installed, or after it's been dismissed on this device. The text is
 * the one-line install instruction for this device; the full guide is one tap
 * away, and Chrome/Edge get a native Install button when the browser offers it.
 */
export function InstallCard() {
  const { me } = useSession();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; } });
  const [installed, setInstalled] = useState(() => isStandalone());
  const [canPrompt, setCanPrompt] = useState(installPromptAvailable());
  useEffect(() => {
    const onInstalled = () => setInstalled(true);
    addEventListener("appinstalled", onInstalled);
    const t = setInterval(() => setCanPrompt(installPromptAvailable()), 500);
    return () => { removeEventListener("appinstalled", onInstalled); clearInterval(t); };
  }, []);
  const short = INSTALL_SHORT[detectInstallPlatform()];
  const show = me && shouldShowInstallCard({ offerInstall: me.flags.offer_install !== false, standalone: installed, dismissed, installable: short !== null });
  if (!show) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* private mode */ } setDismissed(true); };
  return (
    <section className="h-card h-stack" style={{ padding: 16 }} aria-labelledby="install-haven">
      <div className="spread">
        <h2 id="install-haven" style={{ margin: 0, fontSize: 18 }}>Install Haven</h2>
        <button type="button" className="h-icon-btn" aria-label="Dismiss" onClick={dismiss}>✕</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>{short}</p>
      <div className="row-actions">
        {canPrompt && <Button onClick={async () => { await promptInstall(); }}>Install now</Button>}
        <Link className="h-btn h-btn--secondary" to="/install">How to install</Link>
      </div>
    </section>
  );
}
