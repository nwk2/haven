// Haven shell Worker — Batch 0 scaffold.
//
// Serves the SPA (static assets via the ASSETS binding) and the /api/*
// routes. Module API routes are dispatched from the modules' server route
// tables; none are registered yet — Kitchen's routes land in Batch 3.
//
// No login yet: Batch 0 has no auth (temporary local-only bypass, removed
// in Batch 2). The DB binding is declared in wrangler.toml but unused until
// Batch 2; the shell tables already exist from migration 0001.
import { kitchenApiRoutes } from "../../modules/kitchen/server/routes.js";

const VERSION = "0.1.0"; // Batch 0

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

interface ApiRoute {
  method: string;
  path: string;
  handler: (request: Request, env: Env) => Promise<Response> | Response;
}

const moduleRoutes: ApiRoute[] = [...kitchenApiRoutes];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "haven", version: VERSION });
    }

    if (url.pathname.startsWith("/api/")) {
      for (const route of moduleRoutes) {
        if (route.method === request.method && route.path === url.pathname) {
          return route.handler(request, env);
        }
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    // SPA: serve the matching static asset for GET/HEAD; anything else is
    // not a page load. Only a 200 from the assets binding counts as a hit:
    // the binding answers unmatched paths — and /index.html itself — with
    // a 307 redirect to /, and that means "no asset" here. The fallback
    // therefore fetches "/" (which the binding serves with 200), not
    // "/index.html", and builds a fresh GET request so a POST body can
    // never reach the assets fetch disturbed.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200) return asset;
    return env.ASSETS.fetch(new Request(new URL("/", url)));
  },
} satisfies ExportedHandler<Env>;
