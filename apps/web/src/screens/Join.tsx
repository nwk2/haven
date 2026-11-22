import { Button } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../session";

export const PENDING_INVITE = "haven:pendingInvite";
type Result = { kind: "working" } | { kind: "conflict"; joining: string; current: string; owner: boolean } | { kind: "full"; joining: string } | { kind: "expired" } | { kind: "tooMany" } | { kind: "offline" };

/** /join/:code (PRD › First sign-in, paths 1–2; Edge cases; Invites). */
export function Join() {
  const { code = "" } = useParams();
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const [r, setR] = useState<Result>({ kind: "working" });

  async function join() {
    const res = await fetch("/api/join", { method: "POST", headers: { "content-type": "application/json", "x-haven": "1" }, body: JSON.stringify({ code }) }).catch(() => null);
    if (!res) { setR({ kind: "offline" }); return; }
    const body = await res.json().catch(() => ({}));
    if (res.ok) { sessionStorage.removeItem(PENDING_INVITE); await refresh(); nav("/", { replace: true }); return; }
    sessionStorage.removeItem(PENDING_INVITE);
    if (body.error === "already_in_household") setR({ kind: "conflict", joining: body.joining, current: body.current, owner: body.owner });
    else if (body.error === "household_full") setR({ kind: "full", joining: body.joining });
    else if (body.error === "too_many_tries") setR({ kind: "tooMany" });
    else setR({ kind: "expired" });
  }

  useEffect(() => {
    if (me === null) sessionStorage.setItem(PENDING_INVITE, code);
    if (me) void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me === undefined, me === null]);

  if (me === null) return <Navigate to="/login?invite=1" replace />;
  if (r.kind === "expired" && !me?.household) return <Navigate to="/welcome?invite=expired" replace />;

  async function leaveAndJoin() {
    setR({ kind: "working" });
    await fetch("/api/leave", { method: "POST", headers: { "x-haven": "1" } });
    await join();
  }

  return (
    <main className="page narrow h-stack" style={{ gap: 18, paddingTop: 64 }}>
      <img src="/icon-192-maskable.png" alt="" width={64} height={64} className="mark" />
      {r.kind === "working" && <p role="status">Joining…</p>}
      {r.kind === "conflict" && (<>
        <h1 style={{ margin: 0 }}>Join “{r.joining}”?</h1>
        <p className="muted">You’re already in <strong>{r.current}</strong>, and an account can be in one household at a time.</p>
        {r.owner
          ? <><p className="note note--warn">You’re the Owner of {r.current}. Transfer ownership to another member before you can leave and join {r.joining}.</p><Link className="h-btn h-btn--primary" to="/settings">Transfer ownership first</Link></>
          : <><p className="h-card" style={{ padding: 14 }}>Joining {r.joining} means leaving {r.current}. Its recipes and lists stay with {r.current}.</p><Button onClick={leaveAndJoin}>Leave {r.current} and join</Button></>}
        <Link className="h-btn h-btn--text" to="/">Stay in {r.current}</Link>
      </>)}
      {r.kind === "full" && (<><h1 style={{ margin: 0 }}>{r.joining} is full</h1><p className="muted">Households can have up to 6 members. Ask its Owner to make room, or start your own household.</p><Link className="h-btn h-btn--primary" to="/">Back</Link></>)}
      {r.kind === "expired" && (<><h1 style={{ margin: 0 }}>That invite link has expired</h1><p className="muted">Ask the person who sent it for a new one.</p><Link className="h-btn h-btn--primary" to="/">Back</Link></>)}
      {r.kind === "tooMany" && (<><h1 style={{ margin: 0 }}>Too many tries</h1><p className="muted">That invite link has been tried too many times. Wait a few minutes, then open it again. If it still doesn’t work, ask for a new link.</p><Link className="h-btn h-btn--primary" to="/">Back</Link></>)}
      {r.kind === "offline" && (<><h1 style={{ margin: 0 }}>You’re offline</h1><p className="muted">Joining needs a connection. Open the link again when you’re back online.</p><Button onClick={join}>Try again</Button></>)}
    </main>
  );
}
