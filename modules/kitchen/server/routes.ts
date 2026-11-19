// Kitchen module server routes — Batch 0: none yet.
// Batch 3 adds the Recipes / Plan / Today routes here; the shell dispatches
// /api/kitchen/* to this table (see shell/src/index.ts). Handlers receive
// the shell auth context (user + household) — modules run no auth of
// their own (spec §2). The shell guarantees ctx.household is non-null
// before dispatching a module route.
import type { AuthContext } from "../../../shell/src/auth.js";

export interface ApiRoute {
  method: string;
  path: string;
  handler: (
    request: Request,
    env: unknown,
    ctx: AuthContext | null,
  ) => Promise<Response> | Response;
}

export const kitchenApiRoutes: ApiRoute[] = [];
