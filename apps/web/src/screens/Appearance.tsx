import { Segmented } from "@haven/ui";
import { api } from "../api";
import { BackHeader } from "../components/ModuleHeader";
import { useSession } from "../session";
import { applyTheme, cacheTheme, type Mode, type ThemeId } from "../theme";

const THEMES: { id: ThemeId; name: string; tag: string }[] = [
  { id: "market", name: "Market Green", tag: "Calm and practical" },
  { id: "tomato", name: "Tomato & Ink", tag: "Loud and friendly" },
  { id: "night", name: "Night Utility", tag: "Dense and quiet" },
];

export function Appearance() {
  const { me, refresh } = useSession();
  if (!me) return null;
  const set = async (t: { theme?: ThemeId; mode?: Mode }) => {
    const next = { theme: t.theme ?? me.user.theme, mode: t.mode ?? me.user.mode };
    applyTheme(next); cacheTheme(me.user.id, next);
    await api("/api/me", { method: "PATCH", body: JSON.stringify(t) }).catch(() => undefined);
    await refresh();
  };
  return (<>
    <BackHeader title="Appearance" back="/settings" />
    <main className="page h-stack" style={{ gap: 20 }}>
      <section className="h-stack" aria-labelledby="th">
        <h2 id="th" className="h-section-title">Theme</h2>
        <div role="radiogroup" aria-labelledby="th" className="h-stack">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={me.user.theme === t.id} className="h-row theme-option" data-preview={t.id} onClick={() => set({ theme: t.id })}>
              <span className="swatches" data-theme={t.id} data-mode="light" aria-hidden="true"><i /><i /><i /></span>
              <span className="h-row__main"><span className="h-row__title">{t.name}</span><span className="h-row__sub">{t.tag}</span></span>
            </button>
          ))}
        </div>
      </section>
      <section className="h-stack" aria-labelledby="md">
        <h2 id="md" className="h-section-title">Mode</h2>
        <Segmented label="Mode" value={me.user.mode} onChange={(mode) => set({ mode })}
          options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <span className="muted" style={{ fontSize: 12 }}>{me.user.mode === "system" ? "Follows your device." : `Always ${me.user.mode}, whatever your device says.`}</span>
      </section>
      <p className="muted" style={{ fontSize: 12 }}>Only changes how the app looks for you. Saved to your account and applied on all your devices.</p>
    </main>
  </>);
}
