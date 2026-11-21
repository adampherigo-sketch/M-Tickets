/** Rules for organizer-managed events. */
import type { EventStatus } from './types'

export type PublishProblem = 'no_ticket_types' | 'cancelled' | 'already_ended' | 'invalid_dates'

export function publishProblems(
  event: { status: EventStatus; startsAt: Date; endsAt: Date },
  ticketTypeCount: number,
  now: Date,
): PublishProblem[] {
  const problems: PublishProblem[] = []
  if (event.status === 'cancelled') problems.push('cancelled')
  if (event.endsAt <= event.startsAt) problems.push('invalid_dates')
  if (event.endsAt <= now) problems.push('already_ended')
  if (ticketTypeCount === 0) problems.push('no_ticket_types')
  return problems
}

export const PUBLISH_PROBLEM_MESSAGES: Readonly<Record<PublishProblem, string>> = {
  no_ticket_types: 'Add at least one ticket type (an RSVP or a paid ticket) first.',
  cancelled: 'Cancelled events cannot be published again.',
  already_ended: 'This event has already ended.',
  invalid_dates: 'The end time must be after the start time.',
}

export function canUnpublish(status: EventStatus): boolean {
  return status === 'published'
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/

export function isValidEventSlug(slug: string): boolean {
  return SLUG.test(slug)
}

/** "Spring Open House!" -> "spring-open-house" */
export function slugify(text: string, maxLength = 80): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
}
