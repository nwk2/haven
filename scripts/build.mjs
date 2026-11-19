// Assemble dist/ for the Worker assets binding.
//   shell/public/*            -> dist/*
//   shared/*.css, shared/*.js -> dist/*   (tokens, components, shell logic)
//   modules/<name>/client/*   -> dist/<name>/*   (lazy-loaded route chunks)
//
// No bundler: shell and module client code is plain JS, copied as-is. If a
// module later needs a build step, it lands in that module's folder and
// this script calls it. Adding a module means adding its folder — no edit
// here (Batch 1: the module copy is generic over modules/*).
import { cpSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

cpSync(join(root, "shell", "public"), dist, { recursive: true });

// Shared tokens, components and logic: flat into dist/, skipping README.
for (const entry of readdirSync(join(root, "shared"))) {
  const src = join(root, "shared", entry);
  if (statSync(src).isFile() && (entry.endsWith(".css") || entry.endsWith(".js"))) {
    cpSync(src, join(dist, entry));
  }
}

// Every module's client chunk, lazy-loaded under its own path.
for (const name of readdirSync(join(root, "modules"))) {
  const client = join(root, "modules", name, "client");
  if (existsSync(client)) {
    cpSync(client, join(dist, name), { recursive: true });
  }
}

console.log("dist/ assembled");
