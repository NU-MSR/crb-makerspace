-- CRB Makerspace 3D Printer Scheduler — Email notifications migration
-- Apply ONCE in the Supabase SQL Editor on top of schema.sql.
-- Idempotent: safe to re-run.

-- 1. New columns on reservations.
--    email_opt_in defaults to FALSE so that any reservation created without
--    going through the updated form (pre-feature data, direct inserts, etc.)
--    is opted out — no surprise emails. The form always sends an explicit
--    value based on the checkbox, so this only affects non-form inserts.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS email_opt_in BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_email_sent_at TIMESTAMPTZ;

-- 2. If this migration was previously run with DEFAULT true, correct the
--    default now. Idempotent.
ALTER TABLE reservations ALTER COLUMN email_opt_in SET DEFAULT false;

-- 3. Partial index for the cron query (only rows still needing a completion email)
CREATE INDEX IF NOT EXISTS idx_reservations_pending_completion_email
  ON reservations(end_at)
  WHERE status = 'confirmed'
    AND email_opt_in = true
    AND completion_email_sent_at IS NULL;

-- 4. Extensions for cron + outbound HTTP
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 5. Schedule the completion-email job (every 5 minutes).
--    Because email_opt_in defaults to FALSE, pre-feature reservations are
--    automatically excluded from the cron query — no special backfill needed.
--    The publishable key below is the same one used by the frontend
--    (see CONFIG in docs/scheduler-app/app.js) — it's already public, so it can
--    sit inline here. The Edge Function uses its auto-injected service_role
--    internally to update the email-sent timestamps; nothing extra to set up.
--    If you fork this for a different Supabase project, replace the URL and
--    publishable key with that project's values.
SELECT cron.schedule(
  'send-completion-emails',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://indewtgxmkdxaecynamm.supabase.co/functions/v1/send-reservation-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_KAlsObC8ClTx4BTY2rxvjQ_L_ECjpbT'
    ),
    body := jsonb_build_object('action', 'send_completion_emails')
  );
  $$
);

-- 6. Reservation management actions (cancel / adjust / report issue) are
--    handled by the same Edge Function via additional `action` payloads.
--    They require an admin password secret so a designated operator can
--    cancel or adjust any reservation without knowing the booker's email:
--
--      supabase secrets set ADMIN_PASSWORD=<chosen-password>
--
--    Email-match auth is the primary path; ADMIN_PASSWORD is the override.
--    No extra DB setup is needed — the function uses the service-role key
--    that's already auto-injected.

-- To remove the job later:
-- SELECT cron.unschedule('send-completion-emails');

-- To inspect recent runs:
-- SELECT * FROM cron.job_run_details
--   WHERE jobname = 'send-completion-emails'
--   ORDER BY start_time DESC
--   LIMIT 10;
