# Kitchen migrations

Kitchen's D1 migrations live here, one file per migration, in numeric order
(`0001_*.sql`, `0002_*.sql`, …). They land in Batch 3 with the Kitchen core
(Recipes, Plan, Today) and Batch 4 with Shop.

Apply after the shell migrations, in dependency order, with the Cloudflare
helper:

```text
python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cf.py \
  --account 6439147f0ae67010881c1eaac02aca30 \
  --db <haven-d1-uuid> --migrations-dir modules/kitchen/migrations migrations-apply
```

Kitchen tables carry the `cook_*` / `shop_*` prefixes and are
household-scoped, with `household_id` leading composite indexes (spec §8–9).
