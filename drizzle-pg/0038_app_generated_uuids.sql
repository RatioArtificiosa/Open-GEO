-- **Three Postgres `serial` columns that the application fills with UUIDs.**
--
-- `monitor_runs`, `geo_pending_tasks` and `geo_alert_dispatches` were created with
-- `id serial PRIMARY KEY` on Postgres (`0030`, `0031`, `0032`) while their SQLite
-- mirrors — and every writer — use `text` ids.
--
-- ## Why that combination is broken, not merely asymmetric
--
-- The writers all generate the id on the application side:
--   • `MonitorRunRepository.tryBeginRun`  → `${identity.id}`, a `crypto.randomUUID()`
--   • `alertDispatch.recordDispatch`        → `id: crypto.randomUUID()`
--   • `geo_pending_tasks`                  → no writer yet, but its tests insert text ids
--
-- On Postgres a `bigint` column rejects a UUID with **`invalid input syntax for type
-- bigint`**. Two of the three fail loudly and one fails silently:
--   • `tryBeginRun` throws, so `scheduledGeoPatrol` records an error and **skips every
--     project** — the patrol never runs at all on Postgres.
--   • `recordDispatch` throws *inside a `try` whose `catch` swallows it*, so the alert is
--     sent but never logged, the next tick's duplicate check cannot see the row, and
--     every patrol re-sends the same alert.
--
-- ## Why `schema-parity.test.ts` did not catch it
--
-- The gate compares `primaryKeyColumns`, which returns the *set* of key columns. A
-- `serial` primary key and a `text` primary key both return `["id"]`, so the two
-- dialects compared equal while every insert failed. The schema files each carried a
-- comment asserting this was safe — *"`schema-parity.test.ts` compares presence, not
-- the auto-increment strategy"* — which is exactly the hole. The parity test now
-- derives its population from the dialect barrels, so it covers all 60 tables rather
-- than the 54 it previously saw.
--
-- ## Why an ALTER rather than regenerating from `schema.ts`
--
-- Existing Postgres databases (`deploy:postgres` targets hosted-prod) hold integer ids in
-- these columns, and `nextval` on the three auto-created sequences has already advanced.
-- The conversion is `USING id::text` so any rows already written survive as their decimal
-- text, the sequence defaults are dropped so nothing tries to generate a value the
-- application now always supplies, and the sequences themselves are dropped because they
-- become unreachable.
--
-- The tables are new enough that this is a conversion rather than a backfill: any
-- production Postgres row in them was written by a code path that could only have
-- inserted an integer, so `id::text` is lossless.

ALTER TABLE "monitor_runs"
	ALTER COLUMN "id" DROP DEFAULT,
	ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "geo_pending_tasks"
	ALTER COLUMN "id" DROP DEFAULT,
	ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "geo_alert_dispatches"
	ALTER COLUMN "id" DROP DEFAULT,
	ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;
--> statement-breakpoint
DROP SEQUENCE IF EXISTS "monitor_runs_id_seq";
--> statement-breakpoint
DROP SEQUENCE IF EXISTS "geo_pending_tasks_id_seq";
--> statement-breakpoint
DROP SEQUENCE IF EXISTS "geo_alert_dispatches_id_seq";
