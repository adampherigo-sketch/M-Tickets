/**
 * Server-safe presentational components shared by M-Tickets screens. No data
 * fetching here: pages pass in what the repository layer returned. Class names
 * are styled by the host app (apps/web/src/app/globals.css, "mt-" prefix).
 */
import type { ReactNode } from 'react'
import { formatEventDateRange, formatMoney, formatTicketCode, type EventStatus, type TicketStatus } from '../domain'

export function EventDate({ startsAt, endsAt, timezone }: { startsAt: Date; endsAt: Date; timezone: string }) {
  return (
    <time className="mt-date" dateTime={startsAt.toISOString()}>
      {formatEventDateRange(startsAt, endsAt, timezone)}
    </time>
  )
}

export function Money({ cents, currency }: { cents: number; currency: string }) {
  return <span className="mt-money">{formatMoney(cents, currency)}</span>
}

export function PriceLabel({ kind, cents, currency }: { kind: 'rsvp' | 'paid'; cents: number; currency: string }) {
  return kind === 'rsvp' ? <span className="mt-money">Free RSVP</span> : <Money cents={cents} currency={currency} />
}

const STATUS_LABELS: Record<EventStatus | TicketStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  cancelled: 'Cancelled',
  pending: 'Awaiting payment',
  valid: 'Valid',
  checked_in: 'Checked in',
  refunded: 'Refunded',
  void: 'Void',
}

export function StatusBadge({ status }: { status: EventStatus | TicketStatus }) {
  return <span className={`mt-badge mt-badge--${status}`}>{STATUS_LABELS[status]}</span>
}

/** Only rendered when the organizer turned public counts on (the API returns null otherwise). */
export function PublicCounts({ counts }: { counts: { rsvps: number; ticketsSold: number } | null }) {
  if (!counts) return null
  const parts: string[] = []
  if (counts.rsvps > 0) parts.push(`${counts.rsvps} going`)
  if (counts.ticketsSold > 0) parts.push(`${counts.ticketsSold} tickets sold`)
  if (parts.length === 0) return null
  return <p className="mt-counts">{parts.join(' · ')}</p>
}

export function TicketCode({ code }: { code: string }) {
  return <code className="mt-code">{formatTicketCode(code)}</code>
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="mt-stat">
      <span className="mt-stat__value">{value}</span>
      <span className="mt-stat__label">{label}</span>
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mt-empty">
      <p className="mt-empty__title">{title}</p>
      {children}
    </div>
  )
}
