import type { ReactNode } from "react";

/** Shared admin pieces: tab icons, loading skeletons, empty states. */
const svg = (d: ReactNode) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const TabIcon = {
  feedback: svg(<path d="M4 5h16v11H8l-4 4z" />),
  users: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.8 2.6 3 5.2" /></>),
  health: svg(<path d="M3 12h4l3-7 4 14 3-7h4" />),
  switches: svg(<><rect x="2.5" y="7" width="19" height="10" rx="5" /><circle cx="16.5" cy="12" r="3" /></>),
  account: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6" /></>),
};

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="h-stack" aria-busy="true" aria-label="Loading">
      <div className="h-skeleton" style={{ height: 30, width: "45%" }} />
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-skeleton" style={{ height: 56 }} />)}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return <div className="empty"><strong>{title}</strong>{body && <span>{body}</span>}</div>;
}
