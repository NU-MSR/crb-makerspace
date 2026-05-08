// Email templates for reservation notifications.
// All times are formatted in America/Chicago to match the scheduler UI.

const TIMEZONE = 'America/Chicago';
const SCHEDULER_URL = Deno.env.get('SCHEDULER_URL') ?? 'https://nu-msr.github.io/crb-makerspace/scheduler-app/';

export interface ReservationEmailData {
  user_name: string;
  user_contact: string;
  printer_display_name: string;
  start_at: string;
  end_at: string;
  lab: string | null;
  material: string | null;
  project_part: string | null;
  notes: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function formatDateTime(iso: string): string {
  // Recent ICU inserts U+202F (narrow no-break space) before AM/PM. That non-ASCII
  // byte forces denomailer to MIME-encode the Subject header, and its encoded-word
  // output is malformed enough that some clients render the whole raw envelope as
  // the body. Normalize U+202F (and U+00A0) to a regular space to keep Subjects
  // ASCII-clean.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(new Date(iso)).replace(/[\u00a0\u202f]/g, ' ');
}

function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function detailsList(r: ReservationEmailData): { html: string; text: string } {
  const items: Array<[string, string]> = [
    ['Printer', r.printer_display_name],
    ['Start', formatDateTime(r.start_at)],
    ['End', formatDateTime(r.end_at)],
    ['Duration', formatDuration(r.start_at, r.end_at)],
  ];
  if (r.lab) items.push(['Lab/Program', r.lab]);
  if (r.material) items.push(['Material', r.material]);
  if (r.project_part) items.push(['Project/Part', r.project_part]);
  if (r.notes) items.push(['Notes', r.notes]);

  const html = items
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`
    )
    .join('');
  const text = items.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { html: `<table style="border-collapse:collapse;font-size:14px;">${html}</table>`, text };
}

export function renderConfirmationEmail(r: ReservationEmailData): RenderedEmail {
  const subject = `3D Printer Reservation Confirmed: ${r.printer_display_name} on ${formatDateTime(r.start_at)}`;
  const details = detailsList(r);
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;">Your 3D printer reservation is confirmed</h2>
  <p>Hi ${escapeHtml(r.user_name)},</p>
  <p>Your reservation at the CRB Makerspace is confirmed. Details:</p>
  ${details.html}
  <p style="margin-top:20px;">You'll get another email when your print is scheduled to finish.</p>
  <p style="font-size:13px;color:#666;">If your plans change, you can edit or cancel this reservation in the scheduler: <a href="${SCHEDULER_URL}">${SCHEDULER_URL}</a></p>
  <p style="font-size:12px;color:#999;margin-top:24px;">— CRB Makerspace</p>
</body></html>`;
  const text = `Your 3D printer reservation is confirmed

Hi ${r.user_name},

Your reservation at the CRB Makerspace is confirmed. Details:

${details.text}

You'll get another email when your print is scheduled to finish.

If your plans change, you can edit or cancel this reservation in the scheduler:
${SCHEDULER_URL}

— CRB Makerspace`;
  return { subject, html, text };
}

export function renderCompletionEmail(r: ReservationEmailData): RenderedEmail {
  const subject = `Your 3D print on ${r.printer_display_name} should be finished`;
  const details = detailsList(r);
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;">Your print should be finishing now</h2>
  <p>Hi ${escapeHtml(r.user_name)},</p>
  <p>Your reservation on <strong>${escapeHtml(r.printer_display_name)}</strong> is scheduled to end now (${escapeHtml(formatDateTime(r.end_at))}). Please head over and pick up your print so the printer is free for the next user.</p>
  ${details.html}
  <p style="font-size:13px;color:#666;margin-top:20px;">If your print needs more time, you can extend this reservation in the scheduler: <a href="${SCHEDULER_URL}">${SCHEDULER_URL}</a></p>
  <p style="font-size:12px;color:#999;margin-top:24px;">— CRB Makerspace</p>
</body></html>`;
  const text = `Your print should be finishing now

Hi ${r.user_name},

Your reservation on ${r.printer_display_name} is scheduled to end now (${formatDateTime(r.end_at)}). Please head over and pick up your print so the printer is free for the next user.

${details.text}

If your print needs more time, you can extend this reservation in the scheduler:
${SCHEDULER_URL}

— CRB Makerspace`;
  return { subject, html, text };
}
