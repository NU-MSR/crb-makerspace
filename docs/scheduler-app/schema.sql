-- CRB Makerspace 3D Printer Scheduler - Supabase Schema
-- Run this SQL in your Supabase SQL Editor

-- Printers table with enhanced fields
CREATE TABLE printers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL UNIQUE,
  printer_type TEXT NOT NULL, -- e.g., "Bambu X1C", "Bambu P1S", "Prusa XL"
  notes TEXT, -- Info/notes about the printer
  status TEXT NOT NULL DEFAULT 'operational' CHECK (status IN ('operational', 'down', 'maintenance', 'reserved')),
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0, -- Custom sort order (lower numbers appear first)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Reservations table
CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  printer_id UUID NOT NULL REFERENCES printers(id) ON DELETE RESTRICT,
  
  -- Use timestamps instead of separate date/time fields
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  
  -- PII fields (stored but not returned in public queries)
  user_name TEXT NOT NULL,
  user_contact TEXT NOT NULL,
  lab TEXT,
  material TEXT,
  project_part TEXT,
  notes TEXT,

  -- Email notifications (see migration-email.sql for cron setup).
  -- email_opt_in defaults to false so non-form inserts are opted out by
  -- default; the form always sends an explicit value from the checkbox.
  email_opt_in BOOLEAN NOT NULL DEFAULT false,
  confirmation_email_sent_at TIMESTAMPTZ,
  completion_email_sent_at TIMESTAMPTZ,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Constraints
  CONSTRAINT valid_duration CHECK (end_at > start_at),
  CONSTRAINT max_duration CHECK (end_at - start_at <= INTERVAL '168 hours'),
  CONSTRAINT min_duration CHECK (end_at - start_at >= INTERVAL '30 minutes')
);

-- Indexes for performance
CREATE INDEX idx_reservations_printer_start ON reservations(printer_id, start_at);
CREATE INDEX idx_reservations_start_at ON reservations(start_at);
CREATE INDEX idx_reservations_end_at ON reservations(end_at);
CREATE INDEX idx_reservations_status ON reservations(status) WHERE status = 'confirmed';
CREATE INDEX idx_printers_status ON printers(status) WHERE is_active = true;
CREATE INDEX idx_reservations_pending_completion_email
  ON reservations(end_at)
  WHERE status = 'confirmed'
    AND email_opt_in = true
    AND completion_email_sent_at IS NULL;

-- Function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_printers_updated_at
  BEFORE UPDATE ON printers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to check for overlapping reservations
CREATE OR REPLACE FUNCTION check_reservation_overlap(
  p_printer_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_exclude_id UUID DEFAULT NULL
)
RETURNS TABLE(id UUID)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT r.id
  FROM reservations r
  WHERE r.printer_id = p_printer_id
    AND r.status = 'confirmed'
    AND (p_exclude_id IS NULL OR r.id != p_exclude_id)
    AND NOT (r.end_at <= p_start_at OR r.start_at >= p_end_at);
END;
$$;

-- Helper function to convert date + time to timestamptz in Chicago timezone
CREATE OR REPLACE FUNCTION chicago_timestamp(date_str TEXT, time_str TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN (date_str || ' ' || time_str)::TIMESTAMP AT TIME ZONE 'America/Chicago';
END;
$$;

-- Row-Level Security
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE printers ENABLE ROW LEVEL SECURITY;

-- Printers: Public read access (only active printers)
CREATE POLICY "Printers are viewable by everyone"
  ON printers FOR SELECT
  USING (is_active = true);

-- Reservations: Public can read rows, but PII columns are withheld at the
-- GRANT layer (column-level SELECT below), not by this row policy. This policy
-- only governs which ROWS are visible; the column GRANTs govern which COLUMNS.
CREATE POLICY "Reservations are viewable by everyone (without PII)"
  ON reservations FOR SELECT
  USING (true);

-- Reservations: Public can create (with validation)
CREATE POLICY "Anyone can create reservations"
  ON reservations FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    -- Printer must exist and be active/operational
    EXISTS (
      SELECT 1 FROM printers
      WHERE id = printer_id
        AND is_active = true
        AND status = 'operational'
    )
  );

-- View that excludes PII and joins with printers
-- Created as SECURITY INVOKER (default) to ensure RLS policies are enforced for the querying user
DROP VIEW IF EXISTS public_reservations;
CREATE VIEW public_reservations AS
SELECT 
  r.id,
  r.printer_id,
  p.display_name as printer_display_name,
  r.start_at,
  r.end_at,
  r.status,
  r.created_at,
  r.updated_at
FROM reservations r
INNER JOIN printers p ON r.printer_id = p.id
WHERE r.status = 'confirmed'
  AND p.is_active = true
  AND p.status = 'operational';

-- Data API grants. Supabase is moving to explicit opt-in for Data API
-- exposure (enforced on all projects Oct 30, 2026), so RLS policies alone
-- are not enough — anon/authenticated also need table-level GRANTs.
-- See migration-grants.sql for the same statements as a standalone migration.
--
-- IMPORTANT: anon/authenticated get column-level SELECT on reservations,
-- NOT table-wide SELECT. PII columns (user_name, user_contact, lab, material,
-- project_part, notes, email_opt_in, *_email_sent_at) are intentionally NOT
-- granted, so the Data API cannot return them. The public_reservations view,
-- check_reservation_overlap, and the insert-return only need the columns
-- granted below. See migration-restrict-pii.sql for the standalone migration.
GRANT SELECT ON printers TO anon, authenticated;
GRANT INSERT ON reservations TO anon, authenticated;
GRANT SELECT (id, printer_id, start_at, end_at, status, created_at, updated_at)
  ON reservations TO anon, authenticated;
GRANT SELECT ON public_reservations TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  check_reservation_overlap(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID)
  TO anon, authenticated;

-- Seed initial printers (adjust as needed)
-- sort_order: lower numbers appear first (left to right)
INSERT INTO printers (display_name, printer_type, status, is_active, sort_order) VALUES
  ('C-3DPO', 'Bambu X1C', 'operational', true, 1),
  ('R2-3D2', 'Bambu X1C', 'operational', true, 2),
  ('Trooper', 'Bambu P1S', 'operational', true, 3),
  ('Vader', 'Bambu P1S', 'operational', true, 4),
  ('Hydra', 'Prusa XL', 'operational', true, 5)
ON CONFLICT (display_name) DO NOTHING;

