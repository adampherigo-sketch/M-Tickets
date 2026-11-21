/**
 * The dispatcher, the Resend sender and the delivery step of placing an
 * order, with the repository layer faked.
 */
import { InMemoryEventBus } from '@zevaryn/core/events'
import type { DbClient } from '@zevaryn/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimedMessage } from '../../src/db'
import {
  decryptDeliveryToken,
  encryptDeliveryToken,
  generateAccessToken,
  hashAccessToken,
  type PlannableTicketType,
} from '../../src/domain'
import { PaymentProviderRegistry } from '../../src/payments'
import type { EmailMessage, EmailSender, SendResult, TicketsContext } from '../../src/server'

const db = vi.hoisted(() => ({
  claimMessages: vi.fn(),
  finishMessage: vi.fn(),
  replaceAccessTokenHash: vi.fn(),
  saveOrderDelivery: vi.fn(),
  discardOrderDelivery: vi.fn(),
  getPublishedEventForSale: vi.fn(),
  getTicketTypesForSale: vi.fn(),
  placeOrder: vi.fn(),
  getOrderFacts: vi.fn(),
}))
vi.mock('../../src/db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }))

const { dispatchMessages, placeOrder, ResendEmailSender } = await import('../../src/server')

const KEY = 'delivery-key-'.padEnd(40, 'x')
const tenantId = '00000000-0000-4000-8000-000000000001'

function context(overrides: Partial<TicketsContext['config']> = {}): TicketsContext {
  return {
    service: {} as DbClient,
    payments: new PaymentProviderRegistry([]),
    publisher: new InMemoryEventBus(),
    config: {
      appUrl: 'https://app.example.com',
      qrSecret: 'q'.repeat(32),
      holdMinutes: 35,
      checkoutSessionMinutes: 31,
      deliveryKey: KEY,
      smsEnabled: false,
      ...overrides,
    },
    now: () => new Date('2026-12-01T12:00:00Z'),
  }
}

class RecordingSender implements EmailSender {
  sent: EmailMessage[] = []
  constructor(private readonly result: SendResult = { ok: true, providerMessageId: 'em_1' }) {}
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message)
    return this.result
  }
}

async function confirmation(
  overrides: Partial<ClaimedMessage> = {},
  order: Partial<NonNullable<ClaimedMessage['order']>> = {},
) {
  const token = generateAccessToken()
  const hash = await hashAccessToken(token)
  const message: ClaimedMessage = {
    id: '00000000-0000-4000-8000-0000000000a1',
    template: 'order_confirmation',
    channel: 'email',
    toEmail: 'sam@example.com',
    toPhone: null,
    attempts: 1,
    tenantId,
    tenantName: 'Acme Plumbing',
    tenantSlug: 'acme',
    event: {
      title: 'Open House',
      slug: 'open-house',
      startsAt: new Date('2026-12-05T23:00:00Z'),
      endsAt: new Date('2026-12-06T01:00:00Z'),
      timezone: 'America/New_York',
      venueName: null,
      venueAddress: null,
    },
    order: {
      id: '00000000-0000-4000-8000-0000000000b1',
      status: 'completed',
      buyerName: 'Sam',
      totalCents: 0,
      currency: 'USD',
      accessTokenHash: hash,
      tokenCiphertext: await encryptDeliveryToken(token, hash, KEY),
      tickets: [
        { code: 'ABCDEFGHJK', typeName: 'RSVP', attendeeName: 'Sam', status: 'valid' },
        { code: 'MNPQRSTVWX', typeName: 'RSVP', attendeeName: 'Sam', status: 'void' },
      ],
      ...order,
    },
    attendeeName: null,
    ...overrides,
  }
  return { message, token }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.finishMessage.mockImplementation(async (_s, _id, outcome: { sent: boolean; retry?: boolean }) =>
    outcome.sent ? 'sent' : outcome.retry ? 'queued' : 'failed',
  )
})

describe('dispatching a confirmation', () => {
  it('emails the original ticket link and only the live tickets', async () => {
    const { message, token } = await confirmation()
    db.claimMessages.mockResolvedValue([message])
    const email = new RecordingSender()

    const summary = await dispatchMessages(context(), { email, sms: null })

    expect(summary).toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0 })
    expect(email.sent).toHaveLength(1)
    const [sent] = email.sent
    expect(sent).toMatchObject({ to: 'sam@example.com', fromName: 'Acme Plumbing', idempotencyKey: `mt-${message.id}` })
    expect(sent!.text).toContain(`https://app.example.com/t/acme/orders/${token}`)
    expect(sent!.text).toContain('ABCDE-FGHJK')
    expect(sent!.text).not.toContain('MNPQR-STVWX')
    expect(db.finishMessage).toHaveBeenCalledWith({}, message.id, { sent: true, providerMessageId: 'em_1' })
    expect(db.replaceAccessTokenHash).not.toHaveBeenCalled()
  })

  it('issues a fresh link when the stored token is unreadable, and saves it for retries', async () => {
    const { message, token } = await confirmation({}, { tokenCiphertext: null })
    db.claimMessages.mockResolvedValue([message])
    db.replaceAccessTokenHash.mockResolvedValue(true)
    const email = new RecordingSender()

    await dispatchMessages(context(), { email, sms: null })

    const saved = db.saveOrderDelivery.mock.calls[0]![1] as { accessTokenHash: string; tokenCiphertext: string }
    const fresh = await decryptDeliveryToken(saved.tokenCiphertext, saved.accessTokenHash, KEY)
    expect(fresh).not.toBeNull()
    expect(fresh).not.toBe(token)
    expect(db.replaceAccessTokenHash).toHaveBeenCalledWith({}, message.order!.id, {
      previousHash: message.order!.accessTokenHash,
      nextHash: saved.accessTokenHash,
    })
    expect(email.sent[0]!.text).toContain(`/orders/${fresh}`)
  })

  it('does not confirm an order that was refunded before sending', async () => {
    const { message } = await confirmation({}, { status: 'refunded' })
    db.claimMessages.mockResolvedValue([message])
    const email = new RecordingSender()

    const summary = await dispatchMessages(context(), { email, sms: null })

    expect(email.sent).toEqual([])
    expect(summary.failed).toBe(1)
    expect(db.finishMessage).toHaveBeenCalledWith(
      {},
      message.id,
      expect.objectContaining({ sent: false, retry: false }),
    )
  })

  it('retries when the provider is down or no sender is configured', async () => {
    const { message } = await confirmation()
    const sms = await confirmation({
      id: '00000000-0000-4000-8000-0000000000a2',
      channel: 'sms',
      toEmail: null,
      toPhone: '+15551234567',
    })
    db.claimMessages.mockResolvedValue([message, sms.message])
    const email = new RecordingSender({ ok: false, error: 'Resend 503', retryable: true })

    const summary = await dispatchMessages(context(), { email, sms: null })

    expect(summary).toEqual({ claimed: 2, sent: 0, retrying: 2, failed: 0 })
    expect(db.finishMessage).toHaveBeenCalledWith({}, sms.message.id, {
      sent: false,
      error: 'No sms sender is configured',
      retry: true,
    })
  })

  it('keeps going when one message throws', async () => {
    const first = await confirmation()
    const second = await confirmation({ id: '00000000-0000-4000-8000-0000000000a3' })
    db.claimMessages.mockResolvedValue([first.message, second.message])
    let calls = 0
    const email: EmailSender = {
      async send() {
        calls += 1
        if (calls === 1) throw new Error('socket hang up')
        return { ok: true }
      },
    }
    const summary = await dispatchMessages(context(), { email, sms: null })
    expect(summary).toEqual({ claimed: 2, sent: 1, retrying: 1, failed: 0 })
  })

  it('sends a thank-you by name', async () => {
    const { message } = await confirmation({ template: 'thank_you', order: null, attendeeName: 'Sam' })
    db.claimMessages.mockResolvedValue([message])
    const email = new RecordingSender()
    await dispatchMessages(context(), { email, sms: null })
    expect(email.sent[0]).toMatchObject({ subject: 'Thanks for coming to Open House' })
    expect(email.sent[0]!.text).toMatch(/^Hi Sam,/)
  })
})

describe('Resend sender', () => {
  const message: EmailMessage = {
    to: 'sam@example.com',
    fromName: 'Acme "Best" <Plumbing>',
    subject: 'Your tickets',
    html: '<p>hi</p>',
    text: 'hi',
    idempotencyKey: 'mt-1',
  }

  it('posts the message with an idempotency key and a safe From name', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 're_msg_1' }), { status: 200 }))
    const sender = new ResendEmailSender({ apiKey: 're_test', fromAddress: 'tickets@mail.example.com', fetch })
    expect(await sender.send(message)).toEqual({ ok: true, providerMessageId: 're_msg_1' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('mt-1')
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: '"Acme Best Plumbing" <tickets@mail.example.com>',
      to: ['sam@example.com'],
      subject: 'Your tickets',
    })
  })

  it('retries rate limits and outages but not bad requests', async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [409, true],
      [422, false],
      [403, false],
    ] as const) {
      const fetch = vi.fn(async () => new Response('{"message":"nope"}', { status }))
      const sender = new ResendEmailSender({ apiKey: 're_test', fromAddress: 'tickets@mail.example.com', fetch })
      expect(await sender.send(message)).toMatchObject({ ok: false, retryable })
    }
    const offline = new ResendEmailSender({
      apiKey: 're_test',
      fromAddress: 'tickets@mail.example.com',
      fetch: vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    })
    expect(await offline.send(message)).toMatchObject({ ok: false, retryable: true })
  })

  it('refuses a From address with a display name baked in', () => {
    expect(() => new ResendEmailSender({ apiKey: 're_test', fromAddress: 'Acme <a@example.com>' })).toThrow()
  })
})

describe('placing an order saves its delivery first', () => {
  const rsvp: PlannableTicketType = {
    id: '00000000-0000-4000-8000-000000000011',
    name: 'RSVP',
    kind: 'rsvp',
    priceCents: 0,
    currency: 'USD',
    quantityLimit: null,
    taken: 0,
    salesStart: null,
    salesEnd: null,
    maxPerOrder: 5,
    eventEndsAt: new Date('2027-01-01T00:00:00Z'),
  }
  const request = {
    buyerName: 'Sam',
    buyerEmail: 'sam@example.com',
    lines: [{ ticketTypeId: rsvp.id, quantity: 1 }],
  }

  beforeEach(() => {
    db.getPublishedEventForSale.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000002',
      tenantId,
      tenantSlug: 'acme',
      slug: 'open-house',
      title: 'Open House',
      endsAt: new Date('2027-01-01T00:00:00Z'),
    })
    db.getTicketTypesForSale.mockResolvedValue([rsvp])
    db.getOrderFacts.mockResolvedValue(null)
  })

  it('stores the encrypted ticket link before the order, keyed by its hash', async () => {
    db.placeOrder.mockResolvedValue({
      orderId: '00000000-0000-4000-8000-000000000003',
      tenantId,
      eventId: '00000000-0000-4000-8000-000000000002',
      status: 'completed',
      totalCents: 0,
      currency: 'USD',
      ticketIds: ['t1'],
    })
    const outcome = await placeOrder(context(), { clientSlug: 'acme', eventSlug: 'open-house', request })
    expect(outcome.kind).toBe('confirmed')
    const token = (outcome as { orderToken: string }).orderToken
    const saved = db.saveOrderDelivery.mock.calls[0]![1] as {
      accessTokenHash: string
      tenantId: string
      delivery: unknown
      tokenCiphertext: string
    }
    expect(saved).toMatchObject({
      tenantId,
      delivery: { channel: 'email' },
      accessTokenHash: await hashAccessToken(token),
    })
    expect(await decryptDeliveryToken(saved.tokenCiphertext, saved.accessTokenHash, KEY)).toBe(token)
    expect(db.saveOrderDelivery.mock.invocationCallOrder[0]!).toBeLessThan(db.placeOrder.mock.invocationCallOrder[0]!)
  })

  it('refuses text delivery until texting is switched on', async () => {
    const outcome = await placeOrder(context(), {
      clientSlug: 'acme',
      eventSlug: 'open-house',
      request: { ...request, delivery: { channel: 'sms', phone: '555-123-4567' } },
    })
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'sms_unavailable' })
    expect(db.saveOrderDelivery).not.toHaveBeenCalled()
  })

  it('discards the delivery row when the database rejects the order', async () => {
    const { TicketsDbError } = await import('../../src/db')
    db.placeOrder.mockRejectedValue(new TicketsDbError('sold_out', 'sold out'))
    const outcome = await placeOrder(context(), { clientSlug: 'acme', eventSlug: 'open-house', request })
    expect(outcome).toMatchObject({ kind: 'rejected', code: 'sold_out' })
    expect(db.discardOrderDelivery).toHaveBeenCalledWith({}, db.saveOrderDelivery.mock.calls[0]![1].accessTokenHash)
  })
})
