import { useEffect, useState } from "react";
import { api } from "./api";
import { Skeleton } from "./bits";

const LABEL: Record<string, string> = { worker_requests: "Worker requests", do_requests: "Durable Object requests", d1_rows_written: "D1 rows written", d1_rows_read: "D1 rows read" };
interface H { connected: boolean; usage: { metric: string; value: number; limit: number; at: number }[]; metrics: Record<string, number> }

export function Health() {
  const [h, setH] = useState<H | null>(null);
  useEffect(() => { api<H>("/health").then(setH).catch(() => undefined); }, []);
  if (!h) return <Skeleton rows={3} />;
  const over = h.usage.filter((u) => u.value / u.limit >= 0.7);
  const n = (x: number) => new Intl.NumberFormat().format(x);
  return (
    <div className="h-stack" style={{ gap: 18 }}>
      <h1>Health</h1>
      {over.map((u) => <p key={u.metric} role="alert" className="note note--warn"><strong>{LABEL[u.metric]} at {Math.round((u.value / u.limit) * 100)}%.</strong> Free-tier limits are hard stops until 00:00 UTC. Consider Workers Paid ($5/month).</p>)}
      <section className="h-card h-stack" style={{ padding: 18, gap: 14 }}>
        <h2 className="h-section-title">Free-tier usage today (UTC)</h2>
        {!h.connected && (
          <div className="setup">
            <strong>Usage isn’t connected</strong>
            <span>In Cloudflare, add two secrets to the <code>haven-admin</code> Worker:</span>
            <ul>
              <li><code>CF_API_TOKEN</code> <span className="muted">a token with Account Analytics: Read</span></li>
              <li><code>CF_ACCOUNT_ID</code> <span className="muted">from the Workers &amp; Pages overview</span></li>
            </ul>
            <span className="muted">Figures then update at 12:00 and 20:00 UTC.</span>
          </div>
        )}
        {h.connected && !h.usage.length && <p className="muted" style={{ margin: 0 }}>No figures yet today. The next check runs at 12:00 or 20:00 UTC.</p>}
        {h.usage.map((u) => { const pct = Math.round((u.value / u.limit) * 100); return (
          <div key={u.metric} className="h-stack" style={{ gap: 6 }}>
            <div className="spread"><strong>{LABEL[u.metric]}</strong><span className="muted">{n(u.value)} of {n(u.limit)} · {pct}%</span></div>
            <div className="bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={LABEL[u.metric]}><span style={{ width: `${Math.min(pct, 100)}%` }} className={pct >= 70 ? "hot" : ""} /><i aria-hidden="true" /></div>
          </div>); })}
      </section>
      <section className="tiles">
        <div className="h-card tile-stat"><strong>{h.metrics.active}</strong><span>Active households</span><small>last 7 days</small></div>
        <div className="h-card tile-stat"><strong>{h.metrics.households}</strong><span>Households</span><small>in total</small></div>
        <div className="h-card tile-stat"><strong>{h.metrics.tripsFinished}</strong><span>Runs finished</span><small>last 7 days</small></div>
        <div className="h-card tile-stat"><strong>{h.metrics.newFeedback}</strong><span>New feedback</span><small>waiting</small></div>
      </section>
    </div>
  );
}
