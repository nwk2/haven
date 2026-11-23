import Dexie, { type Table } from "dexie";

/** Household tables mirrored on the device (Technical spec › Data model). */
export const TABLES = ["meals_ingredients", "meals_recipes", "meals_planned", "meals_list_states", "activity", "todos_lists", "todos_items", "todos_mutes"] as const;
export type TableName = (typeof TABLES)[number];

/** Columns stored as JSON text in D1, as objects on the device. */
export const JSON_COLS = new Set(["ingredients", "steps", "tags", "recipe_snapshot", "repeat"]);

export interface Row { id: string; version?: number; deleted?: number; [k: string]: unknown }
export interface OutboxEntry { seq?: number; id: string; table: TableName; rowId: string; fields: Record<string, unknown> }

export class HavenDB extends Dexie {
  meta!: Table<{ k: string; v: unknown }, string>;
  outbox!: Table<OutboxEntry, number>;
  meals_ingredients!: Table<Row, string>;
  meals_recipes!: Table<Row, string>;
  meals_planned!: Table<Row, string>;
  meals_list_states!: Table<Row, string>;
  activity!: Table<Row, string>;
  todos_lists!: Table<Row, string>;
  todos_items!: Table<Row, string>;
  todos_mutes!: Table<Row, string>;

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
    // v2 (Nov 2026): To-dos module.
    this.version(2).stores({ todos_lists: "id", todos_items: "id, list_id, due_date", todos_mutes: "id, user_id" });
    // v3 (Nov 2026): the one shopping list — state lives on the meal-ingredient.
    // meals_trips/meals_items stay declared (their rows stop syncing, but a device with
    // unsent trip changes must still be able to re-apply them); the server drops the
    // tables later (migration 0010), after which a v4 can remove them here too.
    this.version(3).stores({ meals_list_states: "id, meal_id" });
  }

  table_(name: TableName): Table<Row, string> { return this.table(name) as Table<Row, string>; }
}

/** List states are keyed by meal on the device: "mealId|ingredientId_family" (extras: "extra_<id>"). */
export const itemId = (mealId: string, key: string) => `${mealId}|${key}`;
