/**
 * Email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * Plain fetch, no SDK. Swapping providers means another EmailSender, nothing else.
 */
import type { EmailMessage, EmailSender, SendResult } from './messaging'

export interface ResendConfig {
  apiKey: string
  /** A verified sender address, e.g. tickets@mail.zevaryn.com. */
  fromAddress: string
  /** Optional Reply-To, e.g. a support inbox. */
  replyTo?: string
  fetch?: typeof fetch
}

/** A display name that cannot break out of the From header. */
function displayName(name: string): string {
  const clean = name
    .replace(/["<>\\\r\n\t]/g, '')
    .trim()
    .slice(0, 70)
  return clean.length > 0 ? clean : 'M-Tickets'
}

export class ResendEmailSender implements EmailSender {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: ResendConfig) {
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(config.fromAddress)) {
      throw new Error('Resend fromAddress must be a plain email address')
    }
    this.fetchImpl = config.fetch ?? fetch
  }

  async send(message: EmailMessage): Promise<SendResult> {
    let response: Response
    try {
      response = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: `"${displayName(message.fromName)}" <${this.config.fromAddress}>`,
          to: [message.to],
          subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 250),
          html: message.html,
          text: message.text,
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      return {
        ok: false,
        error: `Resend unreachable: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      }
    }

    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null
      return typeof body?.id === 'string' ? { ok: true, providerMessageId: body.id } : { ok: true }
    }
    const detail = await response.text().catch(() => '')
    // 429 rate limit, 409 idempotent request still in flight, 5xx outage: try later.
    // Other 4xx (bad address, unverified domain, bad key) will not fix themselves.
    const retryable = response.status === 429 || response.status === 409 || response.status >= 500
    return { ok: false, error: `Resend ${response.status}: ${detail.slice(0, 300)}`, retryable }
  }
}
