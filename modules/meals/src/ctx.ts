import type { HavenDB, Sync } from "@haven/sync";
import { createContext, useContext } from "react";

/** What the shell gives a module (Technical spec › Module contract). Modules never import the app. */
export interface ModuleCtx {
  db: HavenDB;
  sync: Sync;
  user: { id: string; name: string; role: "owner" | "member" | null };
  household: { id: string; name: string; timezone: string; week_start: "mon" | "sun" | "sat"; measurement: "metric" | "us"; default_servings: number | null };
  today: string;
  /** Optional platform features; photos are off until R2 is enabled. */
  features: { photos: boolean };
}
export const Ctx = createContext<ModuleCtx | null>(null);
export const useCtx = () => useContext(Ctx)!;
