/**
 * Pure delivery rules: the encrypted ticket-link token, phone numbers, the
 * buyer's channel choice, and what the messages say.
 */
import { describe, expect, it } from 'vitest'
import {
  decryptDeliveryToken,
  encryptDeliveryToken,
  generateAccessToken,
  hashAccessToken,
  normalizePhone,
  planOrder,
  renderOrderConfirmationEmail,
  renderOrderConfirmationSms,
  renderThankYouEmail,
  type OrderConfirmationInput,
  type PlannableTicketType,
} from '../../src/domain'
import { base64url, fromBase64url } from '../../src/domain/base64url'

const KEY = 'k'.repeat(32)

describe('delivery token encryption', () => {
  it('round-trips and is different every time', async () => {
    const token = generateAccessToken()
    const hash = await hashAccessToken(token)
    const a = await encryptDeliveryToken(token, hash, KEY)
    const b = await encryptDeliveryToken(token, hash, KEY)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(a).not.toContain(token)
    expect(await decryptDeliveryToken(a, hash, KEY)).toBe(token)
  })

  it('refuses another order, another key, tampering and junk', async () => {
    const token = generateAccessToken()
    const hash = await hashAccessToken(token)
    const sealed = await encryptDeliveryToken(token, hash, KEY)
    expect(await decryptDeliveryToken(sealed, await hashAccessToken('other'), KEY)).toBeNull()
    expect(await decryptDeliveryToken(sealed, hash, 'z'.repeat(32))).toBeNull()
    const [v, iv, body] = sealed.split('.')
    const flipped = `${v}.${iv}.${body!.slice(0, -2)}${body!.endsWith('AA') ? 'BB' : 'AA'}`
    expect(await decryptDeliveryToken(flipped, hash, KEY)).toBeNull()
    for (const junk of ['', 'v1', 'v2.a.b', 'v1.a.b.c', 'v1.!!.??']) {
      expect(await decryptDeliveryToken(junk, hash, KEY)).toBeNull()
    }
  })

  it('needs a key of at least 32 characters', async () => {
    await expect(encryptDeliveryToken('t', 'h', 'short')).rejects.toThrow(/32/)
  })

  it('decodes what base64url encodes', () => {
    for (const length of [0, 1, 2, 3, 12, 31, 32]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length))
      expect(fromBase64url(base64url(bytes))).toEqual(bytes)
    }
    expect(fromBase64url('a+b/')).toBeNull()
    expect(fromBase64url('abcde')).toBeNull()
  })
})

describe('phone numbers', () => {
  it('normalizes how people type US numbers and international ones', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567')
    expect(normalizePhone('555.123.4567')).toBe('+15551234567')
    expect(normalizePhone('1 555 123 4567')).toBe('+15551234567')
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
  })

  it('rejects what is not a phone number', () => {
    for (const bad of ['', '123', '555-1234', '+0123456789', 'call me', '555 123 4567 ext 9', '+1234567890123456']) {
      expect(normalizePhone(bad), bad).toBeNull()
    }
  })
})

describe('choosing how tickets are delivered', () => {
  const rsvp: PlannableTicketType = {
    id: 'rsvp',
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
  const base = { buyerName: 'Sam', buyerEmail: 'sam@example.com', lines: [{ ticketTypeId: 'rsvp', quantity: 1 }] }
  const now = new Date('2026-12-01T00:00:00Z')

  it('defaults to email', () => {
    const plan = planOrder(base, [rsvp], now)
    expect(plan.ok && plan.value.delivery).toEqual({ channel: 'email' })
  })

  it('normalizes the phone for text, and rejects a bad one', () => {
    const plan = planOrder({ ...base, delivery: { channel: 'sms', phone: '(555) 123-4567' } }, [rsvp], now)
    expect(plan.ok && plan.value.delivery).toEqual({ channel: 'sms', phone: '+15551234567' })
    const bad = planOrder({ ...base, delivery: { channel: 'sms', phone: 'nope' } }, [rsvp], now)
    expect(bad).toEqual({ ok: false, error: { code: 'invalid_phone' } })
  })
})

describe('message content', () => {
  const input: OrderConfirmationInput = {
    tenantName: 'Acme <Plumbing>',
    event: {
      title: 'Open House <script>alert(1)</script>',
      startsAt: new Date('2026-12-05T23:00:00Z'),
      endsAt: new Date('2026-12-06T01:00:00Z'),
      timezone: 'America/New_York',
      venueName: 'Main St Shop',
      venueAddress: '1 Main St',
    },
    buyerName: 'Sam "Q" Smith',
    totalCents: 5000,
    currency: 'USD',
    ticketLink: 'https://app.example.com/t/acme/orders/abc_DEF-123',
    tickets: [
      { code: 'ABCDEFGHJK', typeName: 'VIP', attendeeName: 'Sam' },
      { code: 'MNPQRSTVWX', typeName: 'VIP', attendeeName: 'Sam' },
    ],
  }

  it('escapes everything that came from the database or the buyer', () => {
    const { html } = renderOrderConfirmationEmail(input)
    expect(html).not.toContain('<script>')
    expect(html).toContain('Open House &lt;script&gt;')
    expect(html).toContain('Acme &lt;Plumbing&gt;')
    expect(html).toContain('Sam &quot;Q&quot; Smith')
  })

  it('carries the ticket link, every code and the price', () => {
    const { subject, html, text } = renderOrderConfirmationEmail(input)
    expect(subject).toBe('Your tickets for Open House <script>alert(1)</script>')
    for (const body of [html, text]) {
      expect(body).toContain(input.ticketLink)
      expect(body).toContain('ABCDE-FGHJK')
      expect(body).toContain('MNPQR-STVWX')
    }
    expect(text).toContain('$50.00')
    expect(text).toContain('Main St Shop, 1 Main St')
  })

  it('words a free order as an RSVP', () => {
    const { subject, text } = renderOrderConfirmationEmail({ ...input, totalCents: 0, tickets: [input.tickets[0]!] })
    expect(subject).toMatch(/^You're on the list/)
    expect(text).toContain('your RSVP is confirmed')
  })

  it('keeps line breaks out of subjects and texts', () => {
    const sneaky = { ...input, event: { ...input.event, title: 'Party\r\nBcc: x@example.com' } }
    expect(renderOrderConfirmationEmail(sneaky).subject).not.toMatch(/[\r\n]/)
    expect(renderOrderConfirmationSms(sneaky)).not.toMatch(/[\r\n]/)
  })

  it('texts the link with an opt-out line', () => {
    const sms = renderOrderConfirmationSms(input)
    expect(sms).toContain(input.ticketLink)
    expect(sms).toMatch(/Reply STOP to opt out\.$/)
    expect(sms).toContain('2 tickets')
  })

  it('thanks a guest by name when there is one', () => {
    expect(renderThankYouEmail({ tenantName: 'Acme', eventTitle: 'Open House', attendeeName: 'Sam' }).text).toMatch(
      /^Hi Sam,/,
    )
    expect(renderThankYouEmail({ tenantName: 'Acme', eventTitle: 'Open House', attendeeName: null }).text).toMatch(
      /^Hi,/,
    )
  })
})
