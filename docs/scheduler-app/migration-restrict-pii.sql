-- CRB Makerspace 3D Printer Scheduler — Restrict reservation PII migration
-- Apply ONCE in the Supabase SQL Editor on top of schema.sql + migration-grants.sql.
-- Idempotent: safe to re-run.
--
-- Background: the `anon` / `authenticated` roles previously held a table-wide
-- SELECT on `reservations`. Combined with the `USING (true)` RLS SELECT policy,
-- that let anyone with the (public) publishable key read every PII column
-- directly via the Data API — e.g.
--   GET /rest/v1/reservations?select=user_name,user_contact
-- completely bypassing the PII-free `public_reservations` view.
--
-- Fix: drop the table-wide SELECT and re-grant SELECT on ONLY the non-PII
-- columns. Postgres enforces column-level privileges, so any query (direct or
-- via PostgREST) that asks for a PII column now fails with
-- "permission denied for column ...". The service_role used by the Edge
-- Function is unaffected and still reads all columns.

-- 1. Remove the over-broad table-level SELECT for the public roles.
REVOKE SELECT ON reservations FROM anon, authenticated;

-- 2. Re-grant SELECT on only the non-PII columns. These are exactly the columns
--    read by everything the public roles legitimately use:
--      - public_reservations view : id, printer_id, start_at, end_at, status,
--                                   created_at, updated_at
--      - check_reservation_overlap: id, printer_id, status, start_at, end_at
--      - insert-return in app.js  : id
--    Deliberately omitted (PII / internal): user_name, user_contact, lab,
--    material, project_part, notes, email_opt_in, confirmation_email_sent_at,
--    completion_email_sent_at.
GRANT SELECT (id, printer_id, start_at, end_at, status, created_at, updated_at)
  ON reservations TO anon, authenticated;

-- INSERT stays table-wide so the booking form can write all columns.
GRANT INSERT ON reservations TO anon, authenticated;

-- Verify (optional): as the anon role, selecting a PII column should error.
--   SET ROLE anon;
--   SELECT user_contact FROM reservations LIMIT 1;   -- expect: permission denied for column user_contact
--   SELECT id, start_at FROM reservations LIMIT 1;    -- expect: succeeds
--   RESET ROLE;
