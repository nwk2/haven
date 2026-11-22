import { useEffect, useState } from "react";
import { api } from "./api";

const LABEL: Record<string, string> = { worker_requests: "Worker requests", do_requests: "Durable Object requests", d1_rows_written: "D1 rows written", d1_rows_read: "D1 rows read" };
interface H { connected: boolean; usage: { metric: string; value: number; limit: number; at: number }[]; metrics: Record<string, number> }

export function Health() {
  const [h, setH] = useState<H | null>(null);
  useEffect(() => { api<H>("/health").then(setH).catch(() => undefined); }, []);
  if (!h) return null;
  const over = h.usage.filter((u) => u.value / u.limit >= 0.7);
  const n = (x: number) => new Intl.NumberFormat().format(x);
  return (
    <div className="h-stack" style={{ gap: 18 }}>
      <h1>Health</h1>
      {over.map((u) => <p key={u.metric} role="alert" className="note note--warn"><strong>{LABEL[u.metric]} at {Math.round((u.value / u.limit) * 100)}%.</strong> Free-tier limits are hard stops until 00:00 UTC. Consider Workers Paid ($5/month).</p>)}
      <section className="h-card h-stack" style={{ padding: 18, gap: 14 }}>
        <h2 className="h-section-title">Free-tier usage today (UTC)</h2>
        {!h.connected && <p className="muted" style={{ margin: 0 }}>Usage isn’t connected yet. Add the CF_API_TOKEN (Account Analytics: Read) and CF_ACCOUNT_ID secrets to the admin Worker; figures update at 12:00 and 20:00 UTC.</p>}
        {h.connected && !h.usage.length && <p className="muted" style={{ margin: 0 }}>No figures yet today. The next check runs at 12:00 or 20:00 UTC.</p>}
        {h.usage.map((u) => { const pct = Math.round((u.value / u.limit) * 100); return (
          <div key={u.metric} className="h-stack" style={{ gap: 6 }}>
            <div className="spread"><strong>{LABEL[u.metric]}</strong><span className="muted">{n(u.value)} of {n(u.limit)} · {pct}%</span></div>
            <div className="bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={LABEL[u.metric]}><span style={{ width: `${Math.min(pct, 100)}%` }} className={pct >= 70 ? "hot" : ""} /><i aria-hidden="true" /></div>
          </div>); })}
      </section>
      <section className="tiles">
        <div className="h-card tile-stat"><strong>{h.metrics.active}</strong><span>Active households (7 days)</span></div>
        <div className="h-card tile-stat"><strong>{h.metrics.households}</strong><span>Households</span></div>
        <div className="h-card tile-stat"><strong>{h.metrics.tripsFinished}</strong><span>Grocery runs finished (7 days)</span></div>
        <div className="h-card tile-stat"><strong>{h.metrics.newFeedback}</strong><span>New feedback</span></div>
      </section>
    </div>
  );
}
