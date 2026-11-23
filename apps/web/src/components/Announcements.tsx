import { Announcement, type AnnouncementData } from "@haven/ui";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useSession } from "../session";

const RANK = { warn: 0, info: 1, ok: 2 } as const;
type A = AnnouncementData & { starts_at: number };

/**
 * Console announcements (decision, Nov 2026): every live one, stacked, most urgent first then newest;
 * two at a time with "+N more"; ✕ dismisses for this person on every device (Undo for 5 seconds).
 * Each appears at its start time and goes at its end time without asking the server again; a change
 * in admin reaches open apps through the household's live connection ("refresh").
 */
export function Announcements() {
  const { me } = useSession();
  const [now, setNow] = useState(Date.now());
  const [hidden, setHidden] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const all = (me?.announcements ?? []) as A[];

  // Re-render exactly when the next one starts or ends.
  useEffect(() => {
    const next = all.flatMap((a) => [a.starts_at, a.ends_at]).filter((t) => t > now).sort((x, y) => x - y)[0];
    if (!next) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 250, 2_147_000_000));
    return () => clearTimeout(t);
  }, [all, now]);
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 5000); return () => clearTimeout(t); }, [undo]);

  const live = all.filter((a) => a.starts_at <= now && a.ends_at > now && !hidden.includes(a.id))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.starts_at - a.starts_at);
  if (!live.length && !undo) return null;
  const shown = expanded ? live : live.slice(0, 2);

  async function dismiss(id: string) {
    setHidden((h) => [...h, id]); setUndo(id);
    await api(`/api/announcements/${id}/dismiss`, { method: "POST" }).catch(() => undefined);
  }
  async function restore(id: string) {
    setUndo(null); setHidden((h) => h.filter((x) => x !== id));
    await api(`/api/announcements/${id}/dismiss`, { method: "DELETE" }).catch(() => undefined);
  }

  return (
    <div className="h-ann-stack">
      {shown.map((a) => <Announcement key={a.id} a={a} onDismiss={() => dismiss(a.id)} />)}
      {live.length > 2 && <button type="button" className="h-ann-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `+${live.length - 2} more announcement${live.length - 2 === 1 ? "" : "s"}`}</button>}
      {undo && <div className="h-toast h-toast--row" role="status"><span>Announcement dismissed</span><button type="button" className="h-toast__action" onClick={() => restore(undo)}>Undo</button></div>}
    </div>
  );
}
