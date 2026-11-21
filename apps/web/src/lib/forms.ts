import type { EventInput, TicketTypeInput } from '@zevaryn/m-tickets/db'
import { isValidEventSlug, parseMoneyToCents, slugify, zonedLocalToUtc } from '@zevaryn/m-tickets/domain'
import { z } from 'zod'

/** Form posts arrive as strings; this turns them into repository inputs or a message. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const text = (max: number) => z.string().trim().max(max)
const local = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Pick a date and time')
const optionalLocal = z.union([z.literal(''), local])

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || 'Form'}: ${issue.message}` : 'Please check the form.'
}

const eventFormSchema = z.object({
  title: text(200).min(1, 'Required'),
  slug: text(80),
  description: text(10000),
  venueName: text(200),
  venueAddress: text(500),
  timezone: text(64).min(1),
  startsAt: local,
  endsAt: local,
  showPublicCounts: z.boolean(),
})

export function parseEventForm(form: FormData, defaultTimezone: string): Parsed<EventInput> {
  const raw = eventFormSchema.safeParse({
    title: field(form, 'title'),
    slug: field(form, 'slug'),
    description: field(form, 'description'),
    venueName: field(form, 'venueName'),
    venueAddress: field(form, 'venueAddress'),
    timezone: field(form, 'timezone') || defaultTimezone,
    startsAt: field(form, 'startsAt'),
    endsAt: field(form, 'endsAt'),
    showPublicCounts: form.get('showPublicCounts') === 'on',
  })
  if (!raw.success) return { ok: false, message: firstIssue(raw.error) }
  const v = raw.data
  const slug = v.slug ? v.slug.toLowerCase() : slugify(v.title)
  if (!isValidEventSlug(slug)) return { ok: false, message: 'Link name: use lowercase letters, numbers and dashes.' }
  let startsAt: Date
  let endsAt: Date
  try {
    startsAt = zonedLocalToUtc(v.startsAt, v.timezone)
    endsAt = zonedLocalToUtc(v.endsAt, v.timezone)
  } catch {
    return { ok: false, message: 'Time zone not recognized.' }
  }
  if (endsAt <= startsAt) return { ok: false, message: 'The end time must be after the start time.' }
  return {
    ok: true,
    value: {
      slug,
      title: v.title,
      description: v.description,
      venueName: v.venueName || null,
      venueAddress: v.venueAddress || null,
      timezone: v.timezone,
      startsAt,
      endsAt,
      showPublicCounts: v.showPublicCounts,
    },
  }
}

const ticketTypeFormSchema = z.object({
  name: text(120).min(1, 'Required'),
  description: text(1000),
  kind: z.enum(['rsvp', 'paid']),
  price: text(20),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter code like USD'),
  quantityLimit: z.union([z.literal(''), z.coerce.number().int().min(1, 'At least 1').max(1_000_000)]),
  maxPerOrder: z.coerce.number().int().min(1).max(50),
  salesStart: optionalLocal,
  salesEnd: optionalLocal,
  sortOrder: z.coerce.number().int().min(0).max(1000),
})

export function parseTicketTypeForm(form: FormData, timezone: string): Parsed<TicketTypeInput> {
  const raw = ticketTypeFormSchema.safeParse({
    name: field(form, 'name'),
    description: field(form, 'description'),
    kind: field(form, 'kind'),
    price: field(form, 'price'),
    currency: field(form, 'currency') || 'USD',
    quantityLimit: field(form, 'quantityLimit').trim(),
    maxPerOrder: field(form, 'maxPerOrder') || '10',
    salesStart: field(form, 'salesStart'),
    salesEnd: field(form, 'salesEnd'),
    sortOrder: field(form, 'sortOrder') || '0',
  })
  if (!raw.success) return { ok: false, message: firstIssue(raw.error) }
  const v = raw.data
  let priceCents = 0
  if (v.kind === 'paid') {
    const cents = parseMoneyToCents(v.price)
    if (cents === null || cents <= 0)
      return { ok: false, message: 'Paid tickets need a price above zero, like 25 or 12.50.' }
    priceCents = cents
  }
  const salesStart = v.salesStart ? zonedLocalToUtc(v.salesStart, timezone) : null
  const salesEnd = v.salesEnd ? zonedLocalToUtc(v.salesEnd, timezone) : null
  if (salesStart && salesEnd && salesEnd <= salesStart)
    return { ok: false, message: 'Sales must end after they start.' }
  return {
    ok: true,
    value: {
      name: v.name,
      description: v.description,
      kind: v.kind,
      priceCents,
      currency: v.currency,
      quantityLimit: v.quantityLimit === '' ? null : v.quantityLimit,
      maxPerOrder: v.maxPerOrder,
      salesStart,
      salesEnd,
      sortOrder: v.sortOrder,
    },
  }
}

/** `qty:<ticketTypeId>` fields from the public order form. */
export function parseOrderLines(form: FormData): { ticketTypeId: string; quantity: number }[] {
  const lines: { ticketTypeId: string; quantity: number }[] = []
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('qty:') || typeof value !== 'string') continue
    const quantity = Number(value)
    if (Number.isInteger(quantity) && quantity > 0) lines.push({ ticketTypeId: key.slice(4), quantity })
  }
  return lines
}

/** Only same-site relative paths, so ?next= cannot redirect off-site. */
export function safeNextPath(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : fallback
}

export function withMessage(path: string, key: 'error' | 'notice', message: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${key}=${encodeURIComponent(message)}`
}
