-- CRB Makerspace 3D Printer Scheduler — Data API grants migration
-- Apply ONCE in the Supabase SQL Editor on top of schema.sql.
-- Idempotent: safe to re-run.
--
-- Background: Supabase is removing automatic Data API exposure for tables in
-- the `public` schema. Starting Oct 30, 2026 (and earlier for new projects),
-- PostgREST/GraphQL access requires explicit GRANT statements — RLS policies
-- alone are not enough. See:
--   https://github.com/orgs/supabase/discussions/45329
--
-- The frontend (docs/scheduler-app/app.js) hits the Data API as `anon` for:
--   - SELECT printers
--   - SELECT public_reservations  (already granted in schema.sql)
--   - INSERT reservations (with .select() to return the new row)
--   - RPC check_reservation_overlap
--
-- The Edge Function uses service_role and is unaffected.
-- RLS policies remain the per-row gate; these grants are the per-table gate.

GRANT SELECT ON printers TO anon, authenticated;

GRANT SELECT, INSERT ON reservations TO anon, authenticated;

GRANT EXECUTE ON FUNCTION
  check_reservation_overlap(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID)
  TO anon, authenticated;
