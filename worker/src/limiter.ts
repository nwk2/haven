/** Counts hits per key in fixed windows; used for invite joins and admin sign-in. */
export class Limiter implements DurableObject {
  constructor(private state: DurableObjectState) {}
  async fetch(req: Request): Promise<Response> {
    const { limit, windowMs } = (await req.json()) as { limit: number; windowMs: number };
    const now = Date.now();
    const w = (await this.state.storage.get<{ start: number; n: number }>("w")) ?? { start: now, n: 0 };
    const cur = now - w.start > windowMs ? { start: now, n: 0 } : w;
    cur.n += 1;
    await this.state.storage.put("w", cur);
    return Response.json({ ok: cur.n <= limit });
  }
}
