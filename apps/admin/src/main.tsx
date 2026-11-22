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

function Shell() {
  const [ok, setOk] = useState<boolean | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api<{ counts: Record<string, number> }>("/feedback?status=new").then((r) => { setOk(true); setUnread(r.counts.new ?? 0); }).catch(() => setOk(false));
  }, []);
  if (ok === null) return null;
  if (!ok) return <Navigate to="/sign-in" replace />;
  const tabs: [string, string][] = [["/feedback", "Feedback"], ["/users", "Users"], ["/health", "Health"], ["/switches", "Switches"], ["/account", "Account"]];
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <div className="admin-brand"><img src="/icon-192-maskable.png" alt="" width={28} height={28} style={{ borderRadius: 7 }} /><span><strong>Haven</strong> <span className="admin-badge">Admin</span></span></div>
        {tabs.map(([to, label]) => <NavLink key={to} to={to}>{label}{to === "/feedback" && unread > 0 && <span className="count">{unread}</span>}</NavLink>)}
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
