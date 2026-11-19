// Kitchen module server routes — Batch 0: none yet.
// Batch 3 adds the Recipes / Plan / Today routes here; the shell dispatches
// /api/kitchen/* to this table (see shell/src/index.ts).
export interface ApiRoute {
  method: string;
  path: string;
  handler: (request: Request, env: unknown) => Promise<Response> | Response;
}

export const kitchenApiRoutes: ApiRoute[] = [];
