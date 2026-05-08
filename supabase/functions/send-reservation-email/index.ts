// Supabase Edge Function: send-reservation-email
//
// Single function with two entry points:
//   1. Database webhook (INSERT on reservations) → sends confirmation email.
//      Body: { type: 'INSERT', table: 'reservations', record: {...} }
//   2. pg_cron (every 5 min) → sends completion emails for finished reservations.
//      Body: { action: 'send_completion_emails' }
//
// Required env vars (set via `supabase secrets set ...`):
//   GMAIL_USER          - e.g. crbmakerspace@gmail.com
//   GMAIL_APP_PASSWORD  - 16-char Google App Password
// Auto-injected by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import { SMTPClient } from 'denomailer';
import {
  renderConfirmationEmail,
  renderCompletionEmail,
  type ReservationEmailData,
  type RenderedEmail,
} from './templates.ts';

const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing required env vars: GMAIL_USER, GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// One SMTP connection is opened per invocation of this function (not per
// message). Gmail rate-limits *logins* much more tightly than messages, so a
// batch of N completion emails reuses a single authenticated connection.
function makeSmtpClient(): SMTPClient {
  return new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER!, password: GMAIL_APP_PASSWORD! },
    },
  });
}

async function sendEmail(client: SMTPClient, to: string, email: RenderedEmail): Promise<void> {
  await client.send({
    from: `CRB Makerspace <${GMAIL_USER}>`,
    to,
    subject: email.subject,
    content: email.text,
    html: email.html,
  });
}

// Shape returned by the join select below.
interface JoinedReservation {
  id: string;
  user_name: string;
  user_contact: string;
  start_at: string;
  end_at: string;
  lab: string | null;
  material: string | null;
  project_part: string | null;
  notes: string | null;
  email_opt_in: boolean;
  printers: { display_name: string } | { display_name: string }[] | null;
}

function toEmailData(r: JoinedReservation): ReservationEmailData {
  // Supabase JS may return a joined to-one relationship as either an object or
  // a single-element array depending on the inferred schema. Handle both.
  const printer = Array.isArray(r.printers) ? r.printers[0] : r.printers;
  return {
    user_name: r.user_name,
    user_contact: r.user_contact,
    printer_display_name: printer?.display_name ?? 'Unknown printer',
    start_at: r.start_at,
    end_at: r.end_at,
    lab: r.lab,
    material: r.material,
    project_part: r.project_part,
    notes: r.notes,
  };
}

const RESERVATION_SELECT =
  'id, user_name, user_contact, start_at, end_at, lab, material, project_part, notes, email_opt_in, printers(display_name)';

async function handleConfirmation(reservationId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase
    .from('reservations')
    .select(RESERVATION_SELECT)
    .eq('id', reservationId)
    .single<JoinedReservation>();
  if (error || !data) return { ok: false, error: error?.message ?? 'Reservation not found' };
  if (!data.email_opt_in) return { ok: true };

  const email = renderConfirmationEmail(toEmailData(data));
  const client = makeSmtpClient();
  try {
    await sendEmail(client, data.user_contact, email);
  } finally {
    await client.close();
  }

  const { error: updateError } = await supabase
    .from('reservations')
    .update({ confirmation_email_sent_at: new Date().toISOString() })
    .eq('id', reservationId);
  if (updateError) return { ok: false, error: updateError.message };
  return { ok: true };
}

async function handleCompletionBatch(): Promise<{ sent: number; failed: number; errors: string[] }> {
  const { data, error } = await supabase
    .from('reservations')
    .select(RESERVATION_SELECT)
    .eq('status', 'confirmed')
    .eq('email_opt_in', true)
    .is('completion_email_sent_at', null)
    .lte('end_at', new Date().toISOString())
    .returns<JoinedReservation[]>();
  if (error) return { sent: 0, failed: 0, errors: [error.message] };
  if (!data || data.length === 0) return { sent: 0, failed: 0, errors: [] };

  // One SMTP connection, sequential sends. Failures are isolated per row so
  // one bad address doesn't block the rest; rows that error stay with
  // completion_email_sent_at = NULL and will be retried on the next cron tick.
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  const client = makeSmtpClient();
  try {
    for (const row of data) {
      try {
        const email = renderCompletionEmail(toEmailData(row));
        await sendEmail(client, row.user_contact, email);
        const { error: updateError } = await supabase
          .from('reservations')
          .update({ completion_email_sent_at: new Date().toISOString() })
          .eq('id', row.id);
        if (updateError) throw new Error(`mark-sent failed for ${row.id}: ${updateError.message}`);
        sent++;
      } catch (e) {
        failed++;
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    await client.close();
  }
  return { sent, failed, errors };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Database webhook payload: INSERT on reservations.
  if (body.type === 'INSERT' && body.table === 'reservations' && body.record) {
    const record = body.record as { id?: string };
    if (!record.id) {
      return new Response(JSON.stringify({ error: 'missing record.id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const result = await handleConfirmation(record.id);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // pg_cron payload.
  if (body.action === 'send_completion_emails') {
    const result = await handleCompletionBatch();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'unrecognized payload' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
});
