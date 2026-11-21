/**
 * Outbound messages: order confirmations (the buyer's ticket link and codes)
 * and post-event thank-yous, by email or text message.
 *
 * Messages are queued in ticket_messages by the database itself: a
 * confirmation in the same transaction that completes the order, a thank-you
 * by tickets_queue_thank_you(). dispatchMessages() drains the queue. It runs
 * right after an order completes and from the cron route, so a crash or a
 * provider outage only delays a message: retries back off over about half an
 * hour, five attempts in all.
 *
 * Senders sit behind two small interfaces. Email: ResendEmailSender (or the
 * logging stub in development). Text: no sender ships yet; when one is added,
 * the composition root registers it and the buyer form offers "Text".
 */
import {
  claimMessages,
  finishMessage,
  replaceAccessTokenHash,
  saveOrderDelivery,
  type ClaimedMessage,
  type MessageOutcome,
} from '../db'
import {
  decryptDeliveryToken,
  encryptDeliveryToken,
  generateAccessToken,
  hashAccessToken,
  renderOrderConfirmationEmail,
  renderOrderConfirmationSms,
  renderThankYouEmail,
  renderThankYouSms,
  type OrderConfirmationInput,
} from '../domain'
import type { TicketsContext } from './context'

export type SendResult = { ok: true; providerMessageId?: string } | { ok: false; error: string; retryable: boolean }

export interface EmailMessage {
  to: string
  /** Shown as the sender's name, e.g. the organizer's business. The address is the platform's. */
  fromName: string
  subject: string
  html: string
  text: string
  /** Stable per queued message, so a retried send is not delivered twice. */
  idempotencyKey: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<SendResult>
}

export interface SmsMessage {
  /** E.164, e.g. +15551234567. */
  to: string
  body: string
  idempotencyKey: string
}

export interface SmsSender {
  send(message: SmsMessage): Promise<SendResult>
}

export interface MessageSenders {
  email: EmailSender | null
  sms: SmsSender | null
}

/** Development stub: logs what would be sent, including the ticket link. */
export class LoggingEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<SendResult> {
    console.info(`[m-tickets] (email stub) to ${message.to}: ${message.subject}\n${message.text}`)
    return { ok: true }
  }
}

export interface DispatchSummary {
  claimed: number
  sent: number
  retrying: number
  failed: number
}

function ticketLink(ctx: TicketsContext, message: ClaimedMessage, token: string): string {
  return `${ctx.config.appUrl}/t/${encodeURIComponent(message.tenantSlug)}/orders/${token}`
}

/**
 * The plaintext ticket-link token for a confirmation. Normally decrypted from
 * the delivery row. If that is missing or unreadable (the row was never
 * written, or the key changed), the order gets a fresh link instead: the buyer
 * must not go without tickets, and the old link was never sent anywhere but
 * the checkout redirect. The new token is saved encrypted right away, so a
 * retry sends the same link instead of minting another.
 */
async function confirmationToken(ctx: TicketsContext, message: ClaimedMessage): Promise<string | null> {
  const order = message.order!
  if (order.tokenCiphertext) {
    const token = await decryptDeliveryToken(order.tokenCiphertext, order.accessTokenHash, ctx.config.deliveryKey)
    if (token && (await hashAccessToken(token)) === order.accessTokenHash) return token
  }
  const token = generateAccessToken()
  const nextHash = await hashAccessToken(token)
  await saveOrderDelivery(ctx.service, {
    accessTokenHash: nextHash,
    tenantId: message.tenantId,
    delivery: message.channel === 'sms' ? { channel: 'sms', phone: message.toPhone! } : { channel: 'email' },
    tokenCiphertext: await encryptDeliveryToken(token, nextHash, ctx.config.deliveryKey),
  })
  const replaced = await replaceAccessTokenHash(ctx.service, order.id, {
    previousHash: order.accessTokenHash,
    nextHash,
  })
  if (!replaced) return null
  console.warn('[m-tickets] issued a new ticket link for a confirmation without a readable token', {
    orderId: order.id,
  })
  return token
}

async function deliver(ctx: TicketsContext, senders: MessageSenders, message: ClaimedMessage): Promise<MessageOutcome> {
  const sender = message.channel === 'email' ? senders.email : senders.sms
  if (!sender) return { sent: false, error: `No ${message.channel} sender is configured`, retry: true }

  let email: { subject: string; html: string; text: string }
  let sms: string
  if (message.template === 'order_confirmation') {
    const order = message.order
    if (!order) return { sent: false, error: 'Order not found', retry: false }
    // Refunded or voided before we got to it: a confirmation would mislead.
    if (order.status !== 'completed') return { sent: false, error: `Order is ${order.status}`, retry: false }
    const token = await confirmationToken(ctx, message)
    if (!token) return { sent: false, error: 'Ticket link changed while sending', retry: true }
    const input: OrderConfirmationInput = {
      tenantName: message.tenantName,
      event: message.event,
      buyerName: order.buyerName,
      totalCents: order.totalCents,
      currency: order.currency,
      ticketLink: ticketLink(ctx, message, token),
      tickets: order.tickets.filter((t) => t.status === 'valid' || t.status === 'checked_in'),
    }
    email = renderOrderConfirmationEmail(input)
    sms = renderOrderConfirmationSms(input)
  } else {
    const input = {
      tenantName: message.tenantName,
      eventTitle: message.event.title,
      attendeeName: message.attendeeName,
    }
    email = renderThankYouEmail(input)
    sms = renderThankYouSms(input)
  }

  const idempotencyKey = `mt-${message.id}`
  const result =
    message.channel === 'email'
      ? await (sender as EmailSender).send({
          to: message.toEmail!,
          fromName: message.tenantName,
          ...email,
          idempotencyKey,
        })
      : await (sender as SmsSender).send({ to: message.toPhone!, body: sms, idempotencyKey })
  return result.ok
    ? { sent: true, ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}) }
    : { sent: false, error: result.error, retry: result.retryable }
}

/**
 * Sends what is due, up to `limit` messages. Safe to run from several places
 * at once: each message is claimed by one worker. Never throws for a single
 * message; a database failure while claiming does throw.
 */
export async function dispatchMessages(
  ctx: TicketsContext,
  senders: MessageSenders,
  options: { limit?: number } = {},
): Promise<DispatchSummary> {
  const claimed = await claimMessages(ctx.service, options.limit ?? 20)
  const summary: DispatchSummary = { claimed: claimed.length, sent: 0, retrying: 0, failed: 0 }
  for (const message of claimed) {
    let outcome: MessageOutcome
    try {
      outcome = await deliver(ctx, senders, message)
    } catch (error) {
      outcome = { sent: false, error: error instanceof Error ? error.message : String(error), retry: true }
    }
    try {
      const status = await finishMessage(ctx.service, message.id, outcome)
      if (status === 'sent') summary.sent += 1
      else if (status === 'queued') summary.retrying += 1
      else summary.failed += 1
      if (status === 'failed') {
        console.error('[m-tickets] message failed for good', { messageId: message.id, template: message.template })
      }
    } catch (error) {
      // The claim expires in 5 minutes and the message is tried again; the
      // idempotency key keeps the provider from delivering it twice.
      console.error('[m-tickets] could not record message outcome', { messageId: message.id }, error)
    }
  }
  return summary
}
