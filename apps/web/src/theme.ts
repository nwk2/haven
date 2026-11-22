export type ThemeId = "market" | "tomato" | "night";
export type Mode = "system" | "light" | "dark";
export const BASE = { theme: "market" as ThemeId, mode: "system" as Mode };

/** 150 ms cross-fade where supported, skipped for reduced motion. */
export function applyTheme(t: { theme: ThemeId; mode: Mode }) {
  const html = document.documentElement;
  if (html.dataset.theme === t.theme && html.dataset.mode === t.mode) return;
  const change = () => { html.dataset.theme = t.theme; html.dataset.mode = t.mode; };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  if (!reduce && doc.startViewTransition) doc.startViewTransition(change);
  else change();
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
