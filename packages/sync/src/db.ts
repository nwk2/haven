import Dexie, { type Table } from "dexie";

/** Household tables mirrored on the device (Technical spec › Data model). */
export const TABLES = ["meals_ingredients", "meals_recipes", "meals_planned", "meals_trips", "meals_items", "activity"] as const;
export type TableName = (typeof TABLES)[number];

/** Columns stored as JSON text in D1, as objects on the device. */
export const JSON_COLS = new Set(["ingredients", "steps", "tags", "final_lines", "recipe_snapshot"]);

export interface Row { id: string; version?: number; deleted?: number; [k: string]: unknown }
export interface OutboxEntry { seq?: number; id: string; table: TableName; rowId: string; fields: Record<string, unknown> }

export class HavenDB extends Dexie {
  meta!: Table<{ k: string; v: unknown }, string>;
  outbox!: Table<OutboxEntry, number>;
  meals_ingredients!: Table<Row, string>;
  meals_recipes!: Table<Row, string>;
  meals_planned!: Table<Row, string>;
  meals_trips!: Table<Row, string>;
  meals_items!: Table<Row, string>;
  activity!: Table<Row, string>;

  constructor(userId: string) {
    // One database per signed-in user, so a shared device never mixes households.
    super(`haven-${userId}`);
    this.version(1).stores({
      meta: "k",
      outbox: "++seq, id, rowId",
      meals_ingredients: "id",
      meals_recipes: "id",
      meals_planned: "id, date",
      meals_trips: "id, date",
      meals_items: "id, trip_id",
      activity: "id, at",
    });
  }

  table_(name: TableName): Table<Row, string> { return this.table(name) as Table<Row, string>; }
}

/** meals_items are keyed by (trip_id, key) on the server; locally by "trip|key". */
export const itemId = (tripId: string, key: string) => `${tripId}|${key}`;
