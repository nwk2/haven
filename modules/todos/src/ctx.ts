import type { HavenDB, Sync } from "@haven/sync";
import { createContext, useContext } from "react";

/** What the shell gives To-dos (Technical spec › Module contract). Modules never import the app. */
export interface ModuleCtx {
  db: HavenDB;
  sync: Sync;
  user: { id: string; name: string; role: "owner" | "member" | null };
  household: { id: string; name: string; timezone: string };
  today: string;
  /** Household members, for the assignee picker and "Added by". */
  members: { id: string; name: string }[];
}
export const Ctx = createContext<ModuleCtx | null>(null);
export const useCtx = () => useContext(Ctx)!;
