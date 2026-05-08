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
  renderIssueReportEmail,
  type ReservationEmailData,
  type RenderedEmail,
} from './templates.ts';

const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD') ?? '';

const ALLOW_ORIGIN = '*';
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};
const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  ...CORS_HEADERS,
};

const MIN_DURATION_MS = 30 * 60 * 1000;
const MAX_DURATION_MS = 168 * 60 * 60 * 1000;
const MAX_REPORT_MESSAGE_LEN = 1000;

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

// Constant-time string compare to avoid timing-based credential leaks.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function credentialMatches(reservation: { user_contact: string }, credential: string): boolean {
  const trimmed = credential.trim();
  if (!trimmed) return false;
  if (ADMIN_PASSWORD && safeEqual(trimmed, ADMIN_PASSWORD)) return true;
  return trimmed.toLowerCase() === reservation.user_contact.trim().toLowerCase();
}

interface CancelOrAdjustRow {
  id: string;
  printer_id: string;
  status: string;
  start_at: string;
  end_at: string;
  user_contact: string;
}

async function handleCancelReservation(reservationId: string, credential: string):
  Promise<{ status: number; body: Record<string, unknown> }> {
  const { data, error } = await supabase
    .from('reservations')
    .select('id, printer_id, status, start_at, end_at, user_contact')
    .eq('id', reservationId)
    .single<CancelOrAdjustRow>();
  if (error || !data) return { status: 404, body: { ok: false, error: 'Reservation not found' } };
  if (!credentialMatches(data, credential)) {
    return { status: 403, body: { ok: false, error: 'Credential did not match' } };
  }
  if (data.status === 'cancelled') return { status: 200, body: { ok: true } };

  const { error: updateError } = await supabase
    .from('reservations')
    .update({ status: 'cancelled' })
    .eq('id', reservationId);
  if (updateError) return { status: 500, body: { ok: false, error: updateError.message } };
  return { status: 200, body: { ok: true } };
}

async function handleAdjustReservation(
  reservationId: string,
  newEndAtIso: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { data, error } = await supabase
    .from('reservations')
    .select('id, printer_id, status, start_at, end_at, user_contact')
    .eq('id', reservationId)
    .single<CancelOrAdjustRow>();
  if (error || !data) return { status: 404, body: { ok: false, error: 'Reservation not found' } };
  if (data.status !== 'confirmed') {
    return { status: 409, body: { ok: false, error: 'Reservation is not active' } };
  }

  const startMs = new Date(data.start_at).getTime();
  const endMs = new Date(newEndAtIso).getTime();
  if (!Number.isFinite(endMs)) {
    return { status: 400, body: { ok: false, error: 'Invalid end time' } };
  }
  const duration = endMs - startMs;
  if (duration < MIN_DURATION_MS) {
    return { status: 400, body: { ok: false, error: 'Duration must be at least 30 minutes' } };
  }
  if (duration > MAX_DURATION_MS) {
    return { status: 400, body: { ok: false, error: 'Duration cannot exceed 168 hours' } };
  }

  const { data: overlaps, error: overlapError } = await supabase.rpc('check_reservation_overlap', {
    p_printer_id: data.printer_id,
    p_start_at: data.start_at,
    p_end_at: newEndAtIso,
    p_exclude_id: reservationId,
  });
  if (overlapError) return { status: 500, body: { ok: false, error: overlapError.message } };
  if (Array.isArray(overlaps) && overlaps.length > 0) {
    return { status: 409, body: { ok: false, error: 'Overlaps an existing reservation' } };
  }

  const { error: updateError } = await supabase
    .from('reservations')
    .update({ end_at: newEndAtIso })
    .eq('id', reservationId);
  if (updateError) return { status: 500, body: { ok: false, error: updateError.message } };
  return { status: 200, body: { ok: true } };
}

async function handleSendIssueReport(
  reservationId: string,
  message: string,
  reporterName: string | null,
  reporterEmail: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { status: 400, body: { ok: false, error: 'Message is required' } };
  }
  if (trimmed.length > MAX_REPORT_MESSAGE_LEN) {
    return { status: 400, body: { ok: false, error: 'Message is too long' } };
  }

  const { data, error } = await supabase
    .from('reservations')
    .select(RESERVATION_SELECT)
    .eq('id', reservationId)
    .single<JoinedReservation>();
  if (error || !data) return { status: 404, body: { ok: false, error: 'Reservation not found' } };

  const email = renderIssueReportEmail(toEmailData(data), {
    message: trimmed,
    reporter_name: reporterName ? reporterName.trim() : null,
    reporter_email: reporterEmail ? reporterEmail.trim() : null,
  });
  const client = makeSmtpClient();
  try {
    await sendEmail(client, data.user_contact, email);
  } finally {
    await client.close();
  }
  return { status: 200, body: { ok: true } };
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

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'invalid json' });
  }

  // Database webhook payload: INSERT on reservations.
  if (body.type === 'INSERT' && body.table === 'reservations' && body.record) {
    const record = body.record as { id?: string };
    if (!record.id) return jsonResponse(400, { error: 'missing record.id' });
    const result = await handleConfirmation(record.id);
    return jsonResponse(result.ok ? 200 : 500, result);
  }

  // pg_cron payload.
  if (body.action === 'send_completion_emails') {
    const result = await handleCompletionBatch();
    return jsonResponse(200, result);
  }

  // User actions from the calendar UI.
  if (body.action === 'cancel_reservation') {
    const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id : '';
    const credential = typeof body.credential === 'string' ? body.credential : '';
    if (!reservationId || !credential) return jsonResponse(400, { ok: false, error: 'reservation_id and credential are required' });
    const { status, body: respBody } = await handleCancelReservation(reservationId, credential);
    return jsonResponse(status, respBody);
  }

  if (body.action === 'adjust_reservation') {
    const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id : '';
    const endAt = typeof body.end_at === 'string' ? body.end_at : '';
    if (!reservationId || !endAt) return jsonResponse(400, { ok: false, error: 'reservation_id and end_at are required' });
    const { status, body: respBody } = await handleAdjustReservation(reservationId, endAt);
    return jsonResponse(status, respBody);
  }

  if (body.action === 'send_issue_report') {
    const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (!reservationId || !message) return jsonResponse(400, { ok: false, error: 'reservation_id and message are required' });
    const reporterName = typeof body.reporter_name === 'string' ? body.reporter_name : null;
    const reporterEmail = typeof body.reporter_email === 'string' ? body.reporter_email : null;
    const { status, body: respBody } = await handleSendIssueReport(reservationId, message, reporterName, reporterEmail);
    return jsonResponse(status, respBody);
  }

  return jsonResponse(400, { error: 'unrecognized payload' });
});
