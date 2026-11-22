import "@haven/tokens/tokens.css";
import "@haven/ui/ui.css";
import "./admin.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { Feedback } from "./Feedback";
import { Health } from "./Health";
import { Denied, SignIn } from "./SignIn";
import { Account, Switches } from "./Switches";
import { Users } from "./Users";
import { Skeleton, TabIcon } from "./bits";

function Shell() {
  const [ok, setOk] = useState<boolean | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api<{ counts: Record<string, number> }>("/feedback?status=new").then((r) => { setOk(true); setUnread(r.counts.new ?? 0); }).catch(() => setOk(false));
  }, []);
  if (ok === null) return <div className="admin"><main className="admin-main"><Skeleton /></main></div>;
  if (!ok) return <Navigate to="/sign-in" replace />;
  const tabs: [string, string, keyof typeof TabIcon][] = [["/feedback", "Feedback", "feedback"], ["/users", "Users", "users"], ["/health", "Health", "health"], ["/switches", "Switches", "switches"], ["/account", "Account", "account"]];
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <div className="admin-brand"><img src="/icon-192-maskable.png" alt="" width={28} height={28} style={{ borderRadius: 7 }} /><span><strong>Haven</strong> <span className="admin-badge">Admin</span></span></div>
        {tabs.map(([to, label, icon]) => <NavLink key={to} to={to} aria-label={to === "/feedback" && unread > 0 ? `${label}, ${unread} new` : label}><span className="tab-icon">{TabIcon[icon]}{to === "/feedback" && unread > 0 && <span className="count">{unread}</span>}</span><span className="tab-label">{label}</span></NavLink>)}
      </nav>
      <header className="admin-top only-phone"><img src="/icon-192-maskable.png" alt="" width={28} height={28} style={{ borderRadius: 7 }} /><span className="admin-badge">Haven admin</span></header>
      <main className="admin-main">
        <Routes>
          <Route path="/feedback" element={<Feedback />} /><Route path="/feedback/:id" element={<Feedback />} />
          <Route path="/users" element={<Users />} /><Route path="/users/:id" element={<Users />} />
          <Route path="/health" element={<Health />} /><Route path="/switches" element={<Switches />} /><Route path="/account" element={<Account />} />
          <Route path="*" element={<Navigate to="/feedback" replace />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter><Routes>
    <Route path="/sign-in" element={<SignIn />} /><Route path="/denied" element={<Denied />} /><Route path="/*" element={<Shell />} />
  </Routes></BrowserRouter></StrictMode>,
);

// Installable, nothing cached (decision, Nov 2026): the service worker only provides the offline screen.
if ("serviceWorker" in navigator) addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js"); });
