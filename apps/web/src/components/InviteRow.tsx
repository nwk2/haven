import { Button } from "@haven/ui";
import { useEffect, useState } from "react";
import { api } from "../api";

/** Settings › invite link (decision Nov 2026: readable code, any member shares, Owner resets). */
export function InviteRow({ owner }: { owner: boolean }) {
  const [inv, setInv] = useState<{ link: string | null; expiresAt?: number }>({ link: null });
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<typeof inv>("/api/invite").then(setInv).catch(() => undefined); }, []);

  const reset = async () => { setBusy(true); try { setInv(await api("/api/invite/reset", { method: "POST" })); setMsg(inv.link ? "New link made; the old one stopped working." : undefined); } finally { setBusy(false); } };
  const share = async () => {
    if (!inv.link) return;
    if (navigator.share) { await navigator.share({ title: "Join my household on Haven", url: inv.link }).catch(() => undefined); return; }
    await navigator.clipboard.writeText(inv.link); setMsg("Link copied");
  };
  const expires = inv.expiresAt ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(inv.expiresAt) : "";

  return (
    <div className="h-row" style={{ flexWrap: "wrap" }}>
      <span className="h-row__main">
        <span className="h-row__title">Invite link</span>
        <span className="h-row__sub" role="status">{msg ?? (inv.link ? `Joins as Member · expires ${expires}` : owner ? "No active link" : "Ask the Owner to make an invite link")}</span>
      </span>
      {owner && <Button variant="secondary" loading={busy} onClick={reset}>{inv.link ? "Reset" : "Make link"}</Button>}
      {inv.link && <Button onClick={share}>{"share" in navigator ? "Share" : "Copy"}</Button>}
    </div>
  );
}
