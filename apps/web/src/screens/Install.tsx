import { Button } from "@haven/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BackHeader } from "../components/ModuleHeader";
import { detectInstallPlatform, installPromptAvailable, promptInstall, type InstallPlatform } from "../install";

const P: Record<InstallPlatform, { name: string; title: string; native?: boolean; steps?: [string, string][]; note?: string }> = {
  ios: { name: "iPhone or iPad", title: "Add Haven to your Home Screen", steps: [["Tap Share", "In the toolbar, at the bottom or top of the screen"], ["Tap “Add to Home Screen”", "Scroll down the list if you don’t see it"], ["Tap Add", "Haven appears with your other apps"]] },
  "android-chrome": { name: "Android · Chrome", title: "Install Haven", native: true, steps: [["Tap the ⋮ menu", "Top right of the browser"], ["Tap “Install app”", "On some phones it says “Add to Home screen”"], ["Tap Install", "Haven appears in your app drawer and home screen"]] },
  "android-samsung": { name: "Android · Samsung Internet", title: "Install Haven", steps: [["Tap the ☰ menu", "Bottom right of the browser"], ["Tap “Add page to”", "Then choose Home screen"], ["Tap Add", "Haven appears on your home screen"]] },
  "android-firefox": { name: "Android · Firefox", title: "Install Haven", steps: [["Tap the ⋮ menu", "Top or bottom right, depending on your toolbar setting"], ["Tap “Add app to Home screen”", "Older versions say “Install”"], ["Tap Add", "Haven appears on your home screen"]] },
  "desktop-chromium": { name: "Computer · Chrome or Edge", title: "Install Haven on this computer", native: true, steps: [["Click the install icon", "At the right end of the address bar; or open the browser menu"], ["Choose “Install Haven”", "In Edge: Apps › Install this site as an app"], ["Click Install", "Haven opens in its own window"]] },
  "mac-safari": { name: "Mac · Safari", title: "Add Haven to your Dock", steps: [["Click File in the menu bar", "Or click Share in the toolbar"], ["Choose “Add to Dock”", "Needs macOS Sonoma or later"], ["Click Add", "Haven appears in your Dock"]] },
  "desktop-firefox": { name: "Computer · Firefox", title: "Installing isn’t available here", note: "Firefox on computers can’t install web apps. Keep using Haven in a tab, or open it in Chrome, Edge or Safari to install it." },
};

export function Install() {
  const nav = useNavigate();
  const [platform, setPlatform] = useState<InstallPlatform>(detectInstallPlatform());
  const [picker, setPicker] = useState(false);
  const [canPrompt, setCanPrompt] = useState(installPromptAvailable());
  useEffect(() => { const t = setInterval(() => setCanPrompt(installPromptAvailable()), 500); return () => clearInterval(t); }, []);
  const p = P[platform];
  return (<>
    <BackHeader title="Install Haven" back="/settings" />
    <main className="page narrow h-stack" style={{ gap: 14 }}>
      <div className="spread"><img src="/icon-192-maskable.png" alt="" width={48} height={48} className="mark" /><div style={{ flex: 1 }}><h2 style={{ margin: 0, fontSize: 20 }}>{p.title}</h2><span className="muted" style={{ fontSize: 13 }}>Opens full screen and works offline in the store.</span></div></div>
      <div className="spread"><span className="muted" style={{ fontSize: 12 }}>Detected: {P[detectInstallPlatform()].name}</span><button className="h-link install__other" aria-expanded={picker} onClick={() => setPicker(!picker)}>Not your device?</button></div>
      {picker && <div role="radiogroup" aria-label="Choose your device" className="chips">{(Object.keys(P) as InstallPlatform[]).map((k) => <button key={k} role="radio" aria-checked={platform === k} className="h-chip" onClick={() => { setPlatform(k); setPicker(false); }}>{P[k].name}</button>)}</div>}
      {p.native && canPrompt && <Button block onClick={async () => { await promptInstall(); nav("/"); }}>Install now</Button>}
      {p.steps && <ol className="plain h-stack">{p.steps.map(([a, b], i) => <li key={a} className="h-row"><span className="step-num" style={{ marginTop: 0 }}>{i + 1}</span><span className="h-row__main"><span className="h-row__title">{a}</span><span className="h-row__sub">{b}</span></span></li>)}</ol>}
      {p.note && <p className="note note--warn">{p.note}</p>}
      <Button variant="secondary" block onClick={() => nav("/")}>Got it</Button>
    </main>
  </>);
}
