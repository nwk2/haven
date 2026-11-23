import type { AnnouncementData } from "@haven/ui";
import { HavenDB, Sync, type SyncStatus } from "@haven/sync";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, SignedOut } from "./api";
import { applyTheme, BASE, cacheTheme, signOutTheme, type Mode, type ThemeId } from "./theme";

export interface Household { id: string; name: string; timezone: string; measurement: "metric" | "us"; default_servings: number | null; enabled_modules: string }
export interface Me {
  user: { id: string; name: string; email: string; photo_url: string | null; theme: ThemeId; mode: Mode; role: "owner" | "member" | null; removed_notice: string | null };
  household: Household | null;
  deletedHousehold: { id: string; name: string; deleted_at: number } | null;
  unreadReplies: number;
  flags: Record<string, boolean>;
  features: { photos: boolean };
  announcements: AnnouncementData[];
  protocol: number;
}

interface Session { me: Me | null | undefined; refresh: () => Promise<void>; db: HavenDB | null; sync: Sync | null; status: SyncStatus; signOut: () => Promise<void> }
const Ctx = createContext<Session | null>(null);
export const useSession = () => useContext(Ctx)!;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [db, setDb] = useState<HavenDB | null>(null);
  const [sync, setSync] = useState<Sync | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ state: "connecting", pending: 0 });

  const refresh = useCallback(async () => {
    try { setMe(await api<Me>("/api/me")); }
    catch (e) { if (e instanceof SignedOut) setMe(null); /* offline: keep what we have */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Coming back to the app re-checks (announcements, replies, roles), at most once a minute.
  useEffect(() => {
    let last = Date.now();
    const onShow = () => { if (document.visibilityState === "visible" && Date.now() - last > 60_000) { last = Date.now(); void refresh(); } };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [refresh]);

  // Theme: base when signed out; member's choice once known (PRD › Base theme).
  useEffect(() => {
    if (me === null) applyTheme(BASE);
    else if (me) { applyTheme(me.user); cacheTheme(me.user.id, me.user); }
  }, [me]);

  // One device database per user; sync only once in a household.
  const userId = me?.user.id; const householdId = me?.household?.id;
  useEffect(() => {
    if (!userId) return;
    const d = new HavenDB(userId); setDb(d);
    if (!householdId) return;
    const s = new Sync(d, me!.protocol, () => void refresh());
    setSync(s);
    const off = s.subscribe(setStatus);
    s.start();
    return () => { off(); s.stop(); setSync(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, householdId]);

  const signOut = useCallback(async () => {
    await api("/api/signout", { method: "POST" }).catch(() => undefined);
    signOutTheme(); setMe(null);
  }, []);

  return <Ctx.Provider value={{ me, refresh, db, sync, status, signOut }}>{children}</Ctx.Provider>;
}
