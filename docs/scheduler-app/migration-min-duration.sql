-- CRB Makerspace 3D Printer Scheduler — Minimum duration migration
-- Apply ONCE in the Supabase SQL Editor on top of schema.sql.
-- Idempotent: safe to re-run.

-- Lower the minimum reservation length from 30 minutes to 1 minute.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS min_duration;
ALTER TABLE reservations
  ADD CONSTRAINT min_duration CHECK (end_at - start_at >= INTERVAL '1 minute');
