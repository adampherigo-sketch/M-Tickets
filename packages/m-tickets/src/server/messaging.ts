/**
 * Outbound messages (thank-you notes today; receipts and reminders later).
 * Messages are queued in ticket_messages by tickets_queue_thank_you(). Nothing
 * sends them yet: a dispatcher that reads queued rows and calls a
 * MessageSender (Resend, Postmark, SES, or an M-System messaging module) is a
 * next step.
 */
export interface OutboundMessage {
  id: string
  template: 'thank_you'
  channel: 'email'
  to: string
  eventId: string
}

export interface MessageSender {
  send(message: OutboundMessage): Promise<{ ok: true } | { ok: false; error: string }>
}

/** Stub: logs instead of sending. */
export class LoggingMessageSender implements MessageSender {
  async send(message: OutboundMessage): Promise<{ ok: true }> {
    console.info(`[m-tickets] (stub) would send ${message.template} ${message.channel} for event ${message.eventId}`)
    return { ok: true }
  }
}
