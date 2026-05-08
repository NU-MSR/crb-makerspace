# CRB Makerspace – 3D Printer Scheduler

A simple, mobile-first single-page web app to reserve 3D printers. Data is stored in Supabase (PostgreSQL database).

- Frontend: static files in `docs/scheduler-app/` (works on GitHub Pages and can be embedded via iframe)
- Backend: Supabase (PostgreSQL database with Row-Level Security)

## Quick Start

### 1) Set up Supabase Database

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (or use your existing project)

2. **Run the schema SQL**:
   - In your Supabase dashboard, go to **SQL Editor**
   - Open and run `schema.sql` from this repo
   - This creates:
     - `printers` table (with `display_name`, `printer_type`, `notes`, `status`)
     - `reservations` table (with proper timestamps and email-notification columns)
     - Indexes for performance
     - Row-Level Security (RLS) policies
     - Database functions for overlap checking
     - Initial printer data
   - **Existing projects only:** also run `migration-email.sql` to add the email-notification columns and the `pg_cron` job. (Fresh installs already have the columns from `schema.sql`, but still need `migration-email.sql` for the cron job.)

3. **Get your Supabase credentials**:
   - Go to **Project Settings** → **Data API**
   - Copy your **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - Go to **Project Settings** → **API Keys**
   - Copy your **publishable key** (starts with `sb_publishable_...`)

### 2) Configure Frontend

1. **Update `app.js`** with your Supabase credentials:
   ```javascript
   const CONFIG = {
     SUPABASE_URL: 'https://your-project.supabase.co', // Your Project URL
     SUPABASE_PUBLISHABLE_KEY: 'your-publishable-key', // Your publishable key
     TIMEZONE: 'America/Chicago',
     // ... rest of config
   };
   ```

2. **Test locally**:
   - Open `docs/scheduler-app/index.html` in a browser (or serve via local server)
   - The app will fetch printers from Supabase and display the calendar

### 3) Deploy to GitHub Pages (MkDocs)

1. **Commit and push** your changes

2. **Embed in MkDocs pages**:
   ```html
   <iframe src="../../scheduler-app/index.html" style="width:100%;height:80vh;border:0;" loading="lazy"></iframe>
   ```
   
   Note: Use relative paths (like `../../scheduler-app/index.html`) when embedding from pages in subdirectories to account for the site's base path.

3. The app is available at `/scheduler-app/` on your GitHub Pages site

### 4) Set up email notifications

The scheduler sends two emails per reservation (when the user opts in via the checkbox under the email field, which is checked by default):

- A **confirmation email** when the reservation is created.
- A **completion email** when the reservation's `end_at` passes (telling the user the print should be finishing).

Both are delivered through a single Supabase Edge Function (`supabase/functions/send-reservation-email`) that authenticates with Gmail SMTP using a Google App Password.

1. **Generate a Gmail App Password**:
   - Sign in to `crbmakerspace@gmail.com` and turn on 2-Step Verification at <https://myaccount.google.com/security>.
   - Go to <https://myaccount.google.com/apppasswords>, create a new app password (e.g. name it "Supabase scheduler"), and copy the 16-character value.

2. **Set Edge Function secrets** (from the repo root):
   ```bash
   supabase login
   supabase link --project-ref indewtgxmkdxaecynamm
   supabase secrets set GMAIL_USER=crbmakerspace@gmail.com GMAIL_APP_PASSWORD=<16-char-app-password>
   # Optional: override the link printed in emails (defaults to the GitHub Pages URL)
   supabase secrets set SCHEDULER_URL=https://crbmakerspace.github.io/crb-makerspace/scheduler-app/
   ```
   You can also set these via **Project Settings → Edge Functions → Secrets** in the dashboard.

3. **Deploy the Edge Function**:
   ```bash
   supabase functions deploy send-reservation-email
   ```
   (Or copy `index.ts`, `templates.ts`, `deno.json` into a new function in the dashboard.)

4. **Create the Database Webhook** (sends the confirmation email when a row is inserted):
   - Dashboard → **Database → Database Webhooks → Create a new hook**
   - Name: `reservation-created`
   - Table: `reservations`, Events: `INSERT`
   - Type: **Supabase Edge Functions**, Function: `send-reservation-email`
   - Method: `POST`, leave the default `Authorization` header in place. Save.

5. **Run `migration-email.sql`** in the SQL Editor:
   - Adds the new columns and the partial index.
   - Enables `pg_cron` and `pg_net`.
   - Schedules the every-5-minute completion-email job, which calls the Edge Function using the **publishable key** (the same one that's already in `app.js`). The publishable key is public, so it sits inline in the cron SQL — no Vault and no service-role key required from you. (The Edge Function still uses its auto-injected `SUPABASE_SERVICE_ROLE_KEY` *internally* to write the email-sent timestamps; that's transparent and needs no setup.)
   - If you fork this for a different Supabase project, edit the project URL and publishable key in `migration-email.sql` before running.

## Database Schema

### Printers Table
- `id` (UUID, primary key)
- `display_name` (TEXT, unique) - e.g., "R2-3D2"
- `printer_type` (TEXT) - e.g., "Bambu X1C", "Bambu P1S"
- `notes` (TEXT, nullable) - Additional info about the printer
- `status` (TEXT) - One of: `'operational'`, `'down'`, `'maintenance'`, `'reserved'`
- `is_active` (BOOLEAN) - Whether the printer appears in the scheduler
- `created_at`, `updated_at` (timestamps)

### Reservations Table
- `id` (UUID, primary key)
- `printer_id` (UUID, foreign key to printers)
- `start_at` (TIMESTAMPTZ) - Start time in Chicago timezone
- `end_at` (TIMESTAMPTZ) - End time in Chicago timezone
- `status` (TEXT) - One of: `'confirmed'`, `'cancelled'`, `'completed'`
- `user_name` (TEXT) - User's name (PII, not returned in public queries)
- `user_contact` (TEXT) - Email address; used to send confirmation and completion notifications (PII, not returned in public queries)
- `lab` (TEXT, nullable) - Lab/program name
- `material` (TEXT, nullable) - Filament material
- `notes` (TEXT, nullable) - Additional notes
- `email_opt_in` (BOOLEAN, default `false`) - Whether to send notification emails for this reservation. The form always passes an explicit value from the checkbox (which is checked by default in the UI); the column default of `false` is a safety net so non-form inserts aren't opted in implicitly.
- `confirmation_email_sent_at` (TIMESTAMPTZ, nullable) - Set by the Edge Function after sending the confirmation
- `completion_email_sent_at` (TIMESTAMPTZ, nullable) - Set by the Edge Function after sending the completion email; doubles as the idempotency flag for the `pg_cron` job
- `created_at`, `updated_at` (timestamps)

### Constraints
- Minimum duration: 30 minutes
- Maximum duration: 168 hours (7 days)
- Time slots must be in 30-minute increments
- No overlapping reservations for the same printer

## Security (Row-Level Security)

- **Public read access**: Anyone can view reservation times (without PII) and operational printers
- **Public write access**: Anyone can create reservations
- **PII protection**: `user_name`, `user_contact`, `lab`, `material`, and `notes` are stored but never returned in public queries (via the `public_reservations` view)
- **Email-sent timestamps are written with the auto-injected service role key**: The `send-reservation-email` Edge Function uses the `SUPABASE_SERVICE_ROLE_KEY` that Supabase auto-injects into every function — you never set or store it. The `pg_cron` job that triggers the function uses only the **publishable key** (already public in `app.js`), so no service-role credential lives in user-managed storage. Emails are only sent for rows where `email_opt_in = true`.

## API (Direct Supabase Client)

The frontend uses the Supabase JavaScript client directly. No custom API endpoints needed.

### Key Functions

- **`fetchPrinters()`**: Fetches active, operational printers from the `printers` table
- **`fetchReservations(date)`**: Fetches reservations that overlap with a given date
- **`createReservation(data)`**: Creates a new reservation with overlap checking

### Overlap Detection

The database function `check_reservation_overlap()` ensures no two confirmed reservations overlap for the same printer. This happens server-side for security and accuracy.

## Timezone Handling

- All timestamps are stored as `TIMESTAMPTZ` (timezone-aware)
- The `chicago_timestamp()` function converts date + time strings to proper timestamps in the `America/Chicago` timezone
- The frontend displays times in Chicago timezone using `Intl.DateTimeFormat`

## Managing Printers

You can manage printers directly in the Supabase dashboard:

1. Go to **Table Editor** → **printers**
2. Add new printers, update status, or edit notes
3. Set `is_active = false` to hide a printer from the scheduler
4. Set `status = 'down'` or `'maintenance'` to temporarily disable reservations

### Changing Printer Order

Printers are ordered by the `sort_order` column (lower numbers appear first, left to right).

**To change the order:**

1. Go to **Table Editor** → **printers**
2. Edit the `sort_order` value for each printer:
   - Lower numbers appear first (left to right)
   - Example: `sort_order = 1` appears before `sort_order = 2`
   - You can use any integers (1, 2, 3, 10, 20, etc.) to allow reordering later
3. Save the changes - the UI will automatically update

## Performance

- **Indexed queries**: Fast lookups by printer and date range
- **Efficient overlap checks**: Database function performs overlap detection server-side
- **No cold starts**: Unlike Google Apps Script, Supabase has no cold start delays
- **Typical response time**: 50-200ms (vs 1-5 seconds with Google Sheets)

## Troubleshooting

### Printers not showing
- Check that printers have `is_active = true` and `status = 'operational'`
- Verify your Supabase credentials in `app.js`
- Check browser console for errors

### Reservations not loading
- Verify RLS policies are enabled
- Check that the `public_reservations` view exists and is accessible
- Check browser console for Supabase errors

### Overlap errors
- The database enforces no overlaps for confirmed reservations
- Check that `check_reservation_overlap()` function exists
- Verify timezone handling is correct

### CORS issues
- Supabase handles CORS automatically for public access
- Ensure your `SUPABASE_PUBLISHABLE_KEY` is correct
- Check that RLS policies allow public access

### Emails not arriving
- Check the recipient's spam folder first.
- Verify the Gmail App Password — open the function logs (`supabase functions logs send-reservation-email`); SMTP auth failures show up as "Invalid login" errors.
- Confirm the Database Webhook is enabled and points at `send-reservation-email` (Dashboard → Database → Webhooks).
- Confirm the row has `email_opt_in = true` and `confirmation_email_sent_at IS NULL`.
- For completion emails, check the cron job is running: `SELECT * FROM cron.job_run_details WHERE jobname = 'send-completion-emails' ORDER BY start_time DESC LIMIT 5;`. Failures show up here even when the function is healthy (e.g. missing Vault secrets).

## Email Notifications

Two emails are sent per reservation when `email_opt_in = true` (the checkbox on the form, checked by default):

- **Confirmation** — sent immediately after the reservation row is inserted, via a Supabase Database Webhook → `send-reservation-email` Edge Function. Records `confirmation_email_sent_at` on the row.
- **Completion** — a `pg_cron` job runs every 5 minutes, calling the same Edge Function with `{ "action": "send_completion_emails" }`. The function selects reservations where `end_at <= now()` and `completion_email_sent_at IS NULL`, sends an email to each, then sets `completion_email_sent_at`. The completion email may therefore be up to ~5 minutes late.

Email transport is Gmail SMTP (`smtp.gmail.com:465`) authenticated with an App Password for `crbmakerspace@gmail.com`. Templates live in `supabase/functions/send-reservation-email/templates.ts`. The link printed in each email defaults to the public scheduler URL and can be overridden with the `SCHEDULER_URL` Edge Function secret.

### Inspecting

- Function logs: `supabase functions logs send-reservation-email --tail` (or Dashboard → Edge Functions → Logs).
- Cron history: `SELECT * FROM cron.job_run_details WHERE jobname = 'send-completion-emails' ORDER BY start_time DESC LIMIT 10;`
- Manually trigger the completion batch:
  ```bash
  curl -X POST 'https://indewtgxmkdxaecynamm.supabase.co/functions/v1/send-reservation-email' \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' \
    -d '{"action":"send_completion_emails"}'
  ```

### Updating templates

The subject lines and bodies for both emails are defined in [supabase/functions/send-reservation-email/templates.ts](../../supabase/functions/send-reservation-email/templates.ts):

- `renderConfirmationEmail()` — sent on reservation creation.
- `renderCompletionEmail()` — sent when `end_at` passes.

Each function returns `{ subject, html, text }`. Edit the strings in place — keep the `html` and `text` versions in sync so recipients on plain-text clients see the same information. Use `escapeHtml()` for any user-supplied values (name, notes, etc.) interpolated into the HTML. Shared helpers (`formatDateTime`, `formatDuration`, `detailsList`) and the `SCHEDULER_URL` link can be reused or adjusted at the top of the file.

After editing, redeploy the function for the changes to take effect:

```bash
supabase functions deploy send-reservation-email
```

To preview changes before deploying, you can trigger a real send by creating a test reservation with `email_opt_in = true`, or by invoking the function locally with `supabase functions serve send-reservation-email` and POSTing a sample payload.

### Disabling

- Per-reservation: uncheck the "Email me updates about this reservation" checkbox.
- Globally (cron only): `SELECT cron.unschedule('send-completion-emails');`
- Globally (confirmations): disable or delete the `reservation-created` Database Webhook.

## Preventing Supabase Project Pause (Keepalive)

Free Supabase projects are paused after 1 week of inactivity. This repository includes a GitHub Actions workflow that runs daily to keep the project active.

### Setting Up the Keepalive Workflow

1. **Add GitHub Secrets**:
   - Go to your repository on GitHub
   - Navigate to **Settings** → **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Add the following secrets:
     - `SUPABASE_URL`: Your Supabase project URL (e.g., `https://xxxxx.supabase.co`)
     - `SUPABASE_PUBLISHABLE_KEY`: Your Supabase publishable key (starts with `sb_publishable_...`)

2. **Verify the Workflow**:
   - The workflow is located at `.github/workflows/supabase-keepalive.yml`
   - It runs daily at 2:00 AM UTC
   - You can manually trigger it from the **Actions** tab in GitHub
   - The workflow makes a simple query to the `printers` table to count as activity

3. **Monitor the Workflow**:
   - Check the **Actions** tab to ensure the workflow runs successfully
   - If it fails, verify that your GitHub secrets are set correctly

## Notes

- Time resolution is 30 minutes, 24-hour view
- Client performs a simple overlap check for UX; server is authoritative
- No cookies or credentials used (public access via publishable key)
- Submitted PII (name and contact) is stored in database but protected by RLS policies
