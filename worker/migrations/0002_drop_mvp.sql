-- Haven v1 · migration 0002 · remove the MVP schema (decision, Nov 2026: MVP data is throwaway).
-- 0001_shell.sql is already recorded as applied in haven-apac, so numbering continues from 0002.
-- Children before parents so foreign keys never block a drop. IF EXISTS keeps this safe on a fresh database.
PRAGMA defer_foreign_keys = true;

DROP TABLE IF EXISTS shop_purchases;
DROP TABLE IF EXISTS shop_list_items;
DROP TABLE IF EXISTS shop_list_groups;
DROP TABLE IF EXISTS shop_runs;
DROP TABLE IF EXISTS shop_pantry_items;
DROP TABLE IF EXISTS shop_items;
DROP TABLE IF EXISTS cook_plan_days;
DROP TABLE IF EXISTS cook_week_plans;
DROP TABLE IF EXISTS cook_recipe_ingredients;
DROP TABLE IF EXISTS cook_recipe_steps;
DROP TABLE IF EXISTS cook_events;
DROP TABLE IF EXISTS cook_recipes;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS modules;
DROP TABLE IF EXISTS household_members;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS households;
DROP TABLE IF EXISTS users;
