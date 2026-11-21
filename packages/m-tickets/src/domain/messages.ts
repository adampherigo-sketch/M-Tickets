/**
 * What M-Tickets sends buyers and guests, rendered from plain data: the order
 * confirmation (ticket link and codes) and the post-event thank-you. Every
 * value from the database or a buyer is HTML-escaped before it goes into an
 * email, and the text-message form stays short enough for one or two segments.
 */
import { formatTicketCode } from './ticketCode'
import { formatEventDateRange } from './time'
import { formatMoney } from './money'

export interface MessageEvent {
  title: string
  startsAt: Date
  endsAt: Date
  timezone: string
  venueName: string | null
  venueAddress: string | null
}

export interface OrderConfirmationInput {
  tenantName: string
  event: MessageEvent
  buyerName: string
  totalCents: number
  currency: string
  ticketLink: string
  tickets: readonly { code: string; typeName: string; attendeeName: string }[]
}

export interface ThankYouInput {
  tenantName: string
  eventTitle: string
  attendeeName: string | null
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Strips line breaks so a buyer-supplied name cannot add lines to a subject or a text message. */
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').trim()

function venueLine(event: MessageEvent): string | null {
  const parts = [event.venueName, event.venueAddress].filter((p): p is string => Boolean(p && p.trim()))
  return parts.length > 0 ? oneLine(parts.join(', ')) : null
}

function layout(tenantName: string, bodyHtml: string, footer: string): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px;">
<tr><td>
<p style="margin:0 0 20px;font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(tenantName)}</p>
${bodyHtml}
</td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#71717a;">${escapeHtml(footer)}</p>
</td></tr>
</table>
</body>
</html>`
}

export function renderOrderConfirmationEmail(input: OrderConfirmationInput): RenderedEmail {
  const title = oneLine(input.event.title)
  const tenant = oneLine(input.tenantName)
  const when = formatEventDateRange(input.event.startsAt, input.event.endsAt, input.event.timezone)
  const where = venueLine(input.event)
  const free = input.totalCents === 0
  const count = input.tickets.length
  const subject = free ? `You're on the list: ${title}` : `Your tickets for ${title}`
  const intro = free
    ? `your RSVP${count === 1 ? ' is' : 's are'} confirmed.`
    : `your order for ${count} ticket${count === 1 ? '' : 's'} (${formatMoney(input.totalCents, input.currency)}) is confirmed.`
  const footer = `You're getting this because you ordered tickets from ${tenant}. Your ticket link is personal: anyone who has it can use your tickets.`

  const rows = input.tickets
    .map(
      (t) => `<tr>
<td style="padding:8px 0;border-top:1px solid #e4e4e7;font-size:14px;">${escapeHtml(t.typeName)}<br><span style="color:#71717a;">${escapeHtml(t.attendeeName)}</span></td>
<td style="padding:8px 0;border-top:1px solid #e4e4e7;font-size:15px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;white-space:nowrap;">${escapeHtml(formatTicketCode(t.code))}</td>
</tr>`,
    )
    .join('\n')

  const html = layout(
    tenant,
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;">${escapeHtml(title)}</h1>
<p style="margin:0 0 4px;font-size:15px;">${escapeHtml(when)}</p>
${where ? `<p style="margin:0 0 4px;font-size:15px;color:#52525b;">${escapeHtml(where)}</p>` : ''}
<p style="margin:20px 0;font-size:15px;line-height:1.5;">Hi ${escapeHtml(oneLine(input.buyerName))}, ${escapeHtml(intro)}</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(input.ticketLink)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;">View your tickets and QR codes</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#52525b;">At the door, show the QR code from your ticket page, or give the code below.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`,
    footer,
  )

  const text = [
    `${tenant}`,
    '',
    title,
    when,
    ...(where ? [where] : []),
    '',
    `Hi ${oneLine(input.buyerName)}, ${intro}`,
    '',
    `Your tickets and QR codes: ${input.ticketLink}`,
    '',
    'At the door, show the QR code from your ticket page, or give the code:',
    ...input.tickets.map((t) => `  ${formatTicketCode(t.code)}  ${oneLine(t.typeName)} (${oneLine(t.attendeeName)})`),
    '',
    footer,
  ].join('\n')

  return { subject, html, text }
}

/** One text message: who it is from, the event, the link, and how to opt out. */
export function renderOrderConfirmationSms(input: OrderConfirmationInput): string {
  const title = oneLine(input.event.title).slice(0, 60)
  const tenant = oneLine(input.tenantName).slice(0, 40)
  const count = input.tickets.length
  const what = input.totalCents === 0 ? `RSVP${count === 1 ? '' : 's'}` : `${count} ticket${count === 1 ? '' : 's'}`
  return `${tenant}: your ${what} for ${title}. Tickets and QR codes: ${input.ticketLink} Reply STOP to opt out.`
}

export function renderThankYouEmail(input: ThankYouInput): RenderedEmail {
  const title = oneLine(input.eventTitle)
  const tenant = oneLine(input.tenantName)
  const greeting = input.attendeeName ? `Hi ${oneLine(input.attendeeName)},` : 'Hi,'
  const body = `Thanks for coming to ${title}. It was great to have you there, and we hope to see you at the next one.`
  const footer = `You're getting this because you checked in at an event run by ${tenant}.`
  return {
    subject: `Thanks for coming to ${title}`,
    html: layout(
      tenant,
      `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(body)}</p>
<p style="margin:0;font-size:15px;line-height:1.5;">${escapeHtml(tenant)}</p>`,
      footer,
    ),
    text: [greeting, '', body, '', tenant, '', footer].join('\n'),
  }
}

export function renderThankYouSms(input: ThankYouInput): string {
  return `${oneLine(input.tenantName).slice(0, 40)}: thanks for coming to ${oneLine(input.eventTitle).slice(0, 60)}! Reply STOP to opt out.`
}
