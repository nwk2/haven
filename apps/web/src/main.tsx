import "@haven/tokens/tokens.css";
import "@haven/ui/ui.css";
import "./app.css";
import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SyncPill } from "./components/SyncPill";
import { Appearance } from "./screens/Appearance";
import { Console } from "./screens/Console";
import { Settings } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { Join, PENDING_INVITE } from "./screens/Join";
import { Help, Thread } from "./screens/Help";
import { Install } from "./screens/Install";
import { Notifications } from "./screens/Notifications";
import { api } from "./api";
import { SessionProvider, useSession } from "./session";
import { todayIn } from "./date";

const MealsModule = lazy(() => import("@haven/module-meals"));
const TodosModule = lazy(() => import("@haven/module-todos"));

function Todos() {
  const { me, db, sync } = useSession();
  const [members, setMembers] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => { api<{ members: { id: string; name: string }[] }>("/api/members").then((r) => setMembers(r.members)).catch(() => setMembers([])); }, []);
  if (!me?.household || !db || !sync || !members) return null;
  if (!me.household.enabled_modules.includes("todos") || me.flags.module_todos_enabled !== true) return <Placeholder title="Tasks is turned off" />;
  const ctx = { db, sync, user: { id: me.user.id, name: me.user.name, role: me.user.role }, household: me.household, today: todayIn(me.household.timezone), members };
  return <Suspense fallback={null}><TodosModule ctx={ctx} /></Suspense>;
}

function Meals() {
  const { me, db, sync } = useSession();
  if (!me?.household || !db || !sync) return null;
  if (!me.household.enabled_modules.includes("meals") || me.flags.module_meals_enabled === false) return <Placeholder title="Meals & Groceries is turned off" />;
  const ctx = { db, sync, user: { id: me.user.id, name: me.user.name, role: me.user.role }, household: me.household, today: todayIn(me.household.timezone), features: me.features ?? { photos: false } };
  return <Suspense fallback={null}><MealsModule ctx={ctx} /></Suspense>;
}

function SignIn() {
  const error = new URLSearchParams(useLocation().search).get("error");
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState("");
  const signInWithToken = () => {
    const t = token.trim();
    if (!t) { setTokenError("Paste a session token first."); return; }
    // No HttpOnly here: a JS-set cookie cannot carry it, but the Worker only
    // reads the Cookie header, so this still signs the probe session in.
    document.cookie = `__Host-haven_session=${t}; Path=/; Secure; SameSite=Lax`;
    window.location.reload();
  };
  return (
    <main className="center">
      <img src="/icon-192-maskable.png" alt="" width={64} height={64} className="mark" />
      <h1>Haven</h1>
      {error === "suspended" && <p role="alert" className="note note--warn">Your account is suspended. If you think this is a mistake, contact the Haven admin.</p>}
      {error === "cancelled" && <p role="alert" className="note note--warn">Sign-in didn’t finish. Nothing was changed. Try again.</p>}
      {sessionStorage.getItem(PENDING_INVITE) && <p className="note note--warn">You’ve been invited to a household on Haven. Sign in to accept.</p>}
      <p className="muted">One shared place for your household — starting with meals and groceries.</p>
      <a className="h-btn h-btn--secondary" href="/auth/google">Continue with Google</a>
      <p className="muted" style={{ fontSize: 12 }}>We use only your Google name, email and photo.</p>
      <details style={{ width: "100%", maxWidth: 320 }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Use a session token</summary>
        <div className="h-stack" style={{ marginTop: 12 }}>
          <input
            id="session-token"
            className="h-input"
            type="text"
            autoComplete="off"
            placeholder="Paste a session token"
            value={token}
            onChange={(e) => { setToken(e.target.value); setTokenError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") signInWithToken(); }}
            aria-invalid={tokenError ? true : undefined}
            style={{ width: "100%" }}
          />
          {tokenError && <p role="alert" className="note note--warn" style={{ margin: 0 }}>{tokenError}</p>}
          <button id="token-signin" className="h-btn h-btn--primary" type="button" onClick={signInWithToken} style={{ width: "100%", justifyContent: "center" }}>Sign in with token</button>
        </div>
      </details>
    </main>
  );
}

function Placeholder({ title }: { title: string }) {
  return <main className="page" style={{ paddingTop: 24 }}><h1>{title}</h1><p className="muted">Coming next in the build.</p></main>;
}

/** Household scheduled for deletion (canvas › Access states). */
function Deleted() {
  const { me, refresh } = useSession();
  const h = me!.deletedHousehold!;
  const until = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(h.deleted_at + 30 * 86_400_000);
  return (
    <main className="page narrow h-stack" style={{ paddingTop: 64, gap: 16 }}>
      <h1 style={{ margin: 0 }}>{h.name} will be deleted on {until}</h1>
      <p className="muted">You deleted this household. Until {until} you can restore it with everything in it. Members can’t open it in the meantime.</p>
      <button className="h-btn h-btn--primary" onClick={async () => { await api("/api/household/restore", { method: "POST" }); await refresh(); }}>Restore {h.name}</button>
    </main>
  );
}

/** Removed from household (canvas › Access states). Shown once. */
function Removed() {
  const { me, refresh, signOut } = useSession();
  const n = JSON.parse(me!.user.removed_notice!) as { household: string; at: number; by: string };
  const dismiss = async (to: string) => { await api("/api/removed-notice/dismiss", { method: "POST" }); await refresh(); location.assign(to); };
  return (
    <main className="page narrow h-stack" style={{ paddingTop: 64, gap: 16 }}>
      <h1 style={{ margin: 0 }}>You’re no longer in {n.household}</h1>
      <p className="muted">{n.by} removed you on {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(n.at)}. Your account is fine. Ask for a new invite link to rejoin, or start your own household.</p>
      <button className="h-btn h-btn--primary" onClick={() => dismiss("/welcome")}>Create a household</button>
      <button className="h-btn h-btn--text" onClick={async () => { await api("/api/removed-notice/dismiss", { method: "POST" }); await signOut(); }}>Sign out</button>
    </main>
  );
}

/** Routes that need a signed-in member with a household. */
function Gate({ children, needsHousehold = true }: { children: React.ReactNode; needsHousehold?: boolean }) {
  const { me } = useSession();
  if (me === undefined) return <main className="center" role="status"><img src="/icon-192-maskable.png" alt="" width={64} height={64} className="mark" /><p>Signing you in…</p></main>;
  if (me === null) return <Navigate to="/login" replace />;
  if (needsHousehold && !me.household && me.deletedHousehold) return <Deleted />;
  if (needsHousehold && !me.household && me.user.removed_notice) return <Removed />;
  if (needsHousehold && !me.household) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

function App() {
  const { me } = useSession();
  useEffect(() => { document.title = me?.household ? `Haven · ${me.household.name}` : "Haven"; }, [me]);
  return (<>
    <SyncPill />
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <SignIn />} />
      <Route path="/login/callback" element={<Gate needsHousehold={false}><Navigate to={sessionStorage.getItem(PENDING_INVITE) ? `/join/${sessionStorage.getItem(PENDING_INVITE)}` : "/"} replace /></Gate>} />
      <Route path="/join/:code" element={<Join />} />
      <Route path="/welcome" element={<Gate needsHousehold={false}>{me?.household ? <Navigate to="/" replace /> : <Welcome />}</Gate>} />
      <Route path="/" element={<Gate><Console /></Gate>} />
      <Route path="/settings" element={<Gate><Settings /></Gate>} />
      <Route path="/settings/appearance" element={<Gate><Appearance /></Gate>} />
      <Route path="/help" element={<Gate><Help /></Gate>} />
      <Route path="/help/:id" element={<Gate><Thread /></Gate>} />
      <Route path="/install" element={<Gate><Install /></Gate>} />
      <Route path="/m/meals/*" element={<Gate><Meals /></Gate>} />
      <Route path="/m/todos/*" element={<Gate><Todos /></Gate>} />
      <Route path="/settings/notifications" element={<Gate><Notifications /></Gate>} />
      <Route path="*" element={<Placeholder title="This page doesn’t exist" />} />
    </Routes>
  </>);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><BrowserRouter><SessionProvider><App /></SessionProvider></BrowserRouter></StrictMode>,
);
