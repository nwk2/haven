// Generates dist/tokens.css from tokens.json.
// <html data-theme="market|tomato|night" data-mode="system|light|dark">
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const t = JSON.parse(readFileSync(new URL("./tokens.json", import.meta.url)));
const kebab = (s) => s.replace(/[A-Z0-9]+/g, (m) => "-" + m.toLowerCase());
const vars = (obj, prefix = "--haven-") =>
  Object.entries(obj).map(([k, v]) => `  ${prefix}${kebab(k)}: ${v};`).join("\n");

const fontStack = (f) => `"${f}", system-ui, -apple-system, "Segoe UI", sans-serif`;
let css = `/* Generated from tokens.json. Do not edit. */\n:root {\n${vars(t.type, "--haven-type-")}\n${vars(t.space, "--haven-space-")}\n${vars(t.motion, "--haven-motion-")}\n  --haven-focus-width: ${t.focus.width};\n  --haven-focus-offset: ${t.focus.offset};\n}\n`;

for (const [id, theme] of Object.entries(t.themes)) {
  const shape = `${vars(theme.shape, "--haven-shape-")}\n  --haven-font-heading: ${fontStack(theme.fonts.heading)};\n  --haven-font-body: ${fontStack(theme.fonts.body)};`;
  css += `\n[data-theme="${id}"] {\n${shape}\n}\n`;
  for (const mode of ["light", "dark"]) {
    const colors = `${vars(theme[mode])}\n${vars(t.overlays[mode], "--haven-overlay-")}\n  color-scheme: ${mode};`;
    css += `[data-theme="${id}"][data-mode="${mode}"] {\n${colors}\n}\n`;
    const media = mode === "dark" ? "(prefers-color-scheme: dark)" : "(prefers-color-scheme: light)";
    css += `@media ${media} {\n  [data-theme="${id}"][data-mode="system"] {\n${colors.replace(/^/gm, "  ")}\n  }\n}\n`;
  }
}
mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/tokens.css", import.meta.url), css);
console.log(`tokens.css: ${Object.keys(t.themes).length} themes × 3 modes, ${css.length} bytes`);
