/** Install detection + the home-screen install card's rules (shared by the Install guide and the Console card). */

/** The platforms the install guide knows how to instruct. */
export type InstallPlatform = "ios" | "android-chrome" | "android-samsung" | "android-firefox" | "desktop-chromium" | "mac-safari" | "desktop-firefox";

/** One-line install instruction per platform; null where installing isn't possible. */
export const INSTALL_SHORT: Record<InstallPlatform, string | null> = {
  ios: "Tap Share, then Add to Home Screen.",
  "android-chrome": "Tap the ⋮ menu, then Install app.",
  "android-samsung": "Tap the ☰ menu, then Add page to, then Home screen.",
  "android-firefox": "Tap the ⋮ menu, then Add app to Home screen.",
  "desktop-chromium": "Click the install icon at the right end of the address bar.",
  "mac-safari": "Click File in the menu bar, then Add to Dock.",
  "desktop-firefox": null,
};

export function detectInstallPlatform(ua: string = navigator.userAgent, maxTouchPoints: number = navigator.maxTouchPoints): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return /SamsungBrowser/.test(ua) ? "android-samsung" : /Firefox/.test(ua) ? "android-firefox" : "android-chrome";
  if (/Firefox/.test(ua)) return "desktop-firefox";
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return "mac-safari";
  return "desktop-chromium";
}

/** True when the app is already running installed (home-screen / standalone) — the install card must not show. */
export function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** The card shows only when the admin flag is on, the app isn't already installed, it hasn't been dismissed on this device, and the platform can install. */
export function shouldShowInstallCard(opts: { offerInstall: boolean; standalone: boolean; dismissed: boolean; installable: boolean }): boolean {
  return opts.offerInstall && !opts.standalone && !opts.dismissed && opts.installable;
}

/** Captured beforeinstallprompt (Chrome, Edge) — one native Install tap when the browser offers it. */
let deferred: (Event & { prompt: () => Promise<void> }) | null = null;
if (typeof window !== "undefined") {
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as typeof deferred; });
}
export function installPromptAvailable(): boolean { return deferred !== null; }
export async function promptInstall(): Promise<void> { await deferred?.prompt(); deferred = null; }
