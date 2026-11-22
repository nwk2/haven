import { Button, Field } from "@haven/ui";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useSession } from "../session";

export function Welcome() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const first = me?.user.name.split(" ")[0] ?? "";
  const [name, setName] = useState(first ? `${first}’s home` : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create() {
    if (!name.trim()) { setError("Give your household a name"); return; }
    setBusy(true);
    try { await api("/api/households", { method: "POST", body: JSON.stringify({ name }) }); await refresh(); nav("/"); }
    catch { setError("Couldn’t create the household. Check your connection and try again."); setBusy(false); }
  }

  return (
    <main className="page narrow h-stack" style={{ gap: 24, paddingTop: 48 }}>
      {params.get("invite") === "expired" && (
        <div role="status" className="note note--warn"><strong>That invite link has expired.</strong> Ask the person who sent it for a new one, or create your own household below.</div>
      )}
      <div className="h-stack" style={{ gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 30 }}>Hi {first}, let’s set up your household</h1>
        <p className="muted" style={{ margin: 0 }}>Everyone you invite shares its recipes, meal plan and grocery lists.</p>
      </div>
      <Field label="Household name" value={name} onChange={(e) => { setName(e.target.value); setError(undefined); }} hint="You’ll be the owner. You can rename it any time." error={error} maxLength={60} />
      <Button block loading={busy} onClick={create}>Create household</Button>
      <p className="muted center-text" style={{ fontSize: 13 }}>Joining someone else’s household? Open the invite link they sent you.</p>
    </main>
  );
}
