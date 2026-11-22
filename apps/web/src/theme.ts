export type ThemeId = "market" | "tomato" | "night";
export type Mode = "system" | "light" | "dark";
export const BASE = { theme: "market" as ThemeId, mode: "system" as Mode };

/** Apply immediately. No view transition: the 150 ms cross-fade CSS was never
 * written, so the browser-default transition blends dark↔light through grey. */
export function applyTheme(t: { theme: ThemeId; mode: Mode }) {
  const html = document.documentElement;
  if (html.dataset.theme === t.theme && html.dataset.mode === t.mode) return;
  html.dataset.theme = t.theme;
  html.dataset.mode = t.mode;
}

/** Remember the member's choice so the next launch paints it before React loads. */
export function cacheTheme(userId: string, t: { theme: ThemeId; mode: Mode }) {
  try {
    localStorage.setItem("haven:lastUser", userId);
    localStorage.setItem(`haven:theme:${userId}`, JSON.stringify(t));
  } catch { /* storage can be unavailable */ }
}

export function signOutTheme() {
  try { localStorage.removeItem("haven:lastUser"); } catch { /* ignore */ }
  applyTheme(BASE);
}
