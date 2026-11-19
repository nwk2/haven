// Assemble dist/ for the Worker assets binding.
//   shell/public/*            -> dist/*
//   modules/<name>/client/*   -> dist/<name>/*   (lazy-loaded route chunks)
//
// No bundler in Batch 0: the shell page and the Kitchen chunk are plain JS
// files, copied as-is. If a module later needs a build step, it lands in
// that module's folder and this script calls it.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

cpSync(join(root, "shell", "public"), dist, { recursive: true });
cpSync(join(root, "modules", "kitchen", "client"), join(dist, "kitchen"), {
  recursive: true,
});

console.log("dist/ assembled");
