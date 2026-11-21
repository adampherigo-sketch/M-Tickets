import { describe, expect, it } from 'vitest'
import {
  InvalidTicketTransitionError,
  applyTransition,
  canTransition,
  decideCheckIn,
  isTerminal,
  publishProblems,
  slugify,
  tallyAttendance,
  utcToZonedLocal,
  zonedLocalToUtc,
  type TicketStatus,
  type TicketTransition,
} from '../../src/domain'

const ALL: TicketStatus[] = ['pending', 'valid', 'checked_in', 'refunded', 'void']
const TRANSITIONS: TicketTransition[] = ['confirm_payment', 'check_in', 'refund', 'void']

describe('ticket state transitions', () => {
  it('matches the documented state machine exactly', () => {
    const allowed = new Set([
      'pending:confirm_payment',
      'pending:void',
      'valid:check_in',
      'valid:refund',
      'valid:void',
      'checked_in:refund',
    ])
    for (const status of ALL) {
      for (const transition of TRANSITIONS) {
        expect(canTransition(status, transition), `${status} -> ${transition}`).toBe(
          allowed.has(`${status}:${transition}`),
        )
      }
    }
  })

  it('checks in a valid ticket exactly once', () => {
    const checkedIn = applyTransition('valid', 'check_in')
    expect(checkedIn).toBe('checked_in')
    expect(() => applyTransition(checkedIn, 'check_in')).toThrow(InvalidTicketTransitionError)
  })

  it('never checks in unpaid, refunded or void tickets', () => {
    for (const status of ['pending', 'refunded', 'void'] as const) {
      expect(() => applyTransition(status, 'check_in')).toThrow(InvalidTicketTransitionError)
    }
  })

  it('treats refunded and void as terminal', () => {
    expect(ALL.filter(isTerminal)).toEqual(['refunded', 'void'])
  })

  it('decides check-in outcomes', () => {
    expect(decideCheckIn(null, 'e1')).toBe('not_found')
    expect(decideCheckIn({ status: 'valid', eventId: 'e2' }, 'e1')).toBe('wrong_event')
    expect(decideCheckIn({ status: 'valid', eventId: 'e1' }, 'e1')).toBe('checked_in')
    expect(decideCheckIn({ status: 'checked_in', eventId: 'e1' }, 'e1')).toBe('already_checked_in')
    expect(decideCheckIn({ status: 'refunded', eventId: 'e1' }, 'e1')).toBe('not_valid')
    expect(decideCheckIn({ status: 'pending', eventId: 'e1' }, 'e1')).toBe('not_valid')
  })

  it('tallies arrivals among admitting tickets only', () => {
    const statuses: TicketStatus[] = ['valid', 'valid', 'checked_in', 'refunded', 'void', 'pending', 'checked_in']
    expect(tallyAttendance(statuses.map((status) => ({ status })))).toEqual({
      expected: 4,
      checkedIn: 2,
      notArrived: 2,
      percentArrived: 50,
    })
    expect(tallyAttendance([])).toEqual({ expected: 0, checkedIn: 0, notArrived: 0, percentArrived: 0 })
  })
})

describe('event rules', () => {
  const now = new Date('2026-12-01T00:00:00Z')
  const event = {
    status: 'draft' as const,
    startsAt: new Date('2026-12-05T18:00:00Z'),
    endsAt: new Date('2026-12-05T21:00:00Z'),
  }

  it('needs a ticket type and a future end to publish', () => {
    expect(publishProblems(event, 1, now)).toEqual([])
    expect(publishProblems(event, 0, now)).toEqual(['no_ticket_types'])
    expect(publishProblems({ ...event, status: 'cancelled' }, 1, now)).toEqual(['cancelled'])
    expect(publishProblems(event, 1, new Date('2026-12-06T00:00:00Z'))).toEqual(['already_ended'])
  })

  it('slugifies titles', () => {
    expect(slugify('Spring Open House!')).toBe('spring-open-house')
    expect(slugify('  Café — Night  ')).toBe('cafe-night')
  })
})

describe('event-local times', () => {
  it('converts wall-clock time in the event time zone, across DST', () => {
    expect(zonedLocalToUtc('2026-12-05T18:30', 'America/New_York').toISOString()).toBe('2026-12-05T23:30:00.000Z')
    expect(zonedLocalToUtc('2026-07-04T18:30', 'America/New_York').toISOString()).toBe('2026-07-04T22:30:00.000Z')
    expect(zonedLocalToUtc('2026-03-08T03:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(utcToZonedLocal(new Date('2026-12-05T23:30:00Z'), 'America/New_York')).toBe('2026-12-05T18:30')
    expect(utcToZonedLocal(new Date('2026-07-04T22:30:00Z'), 'America/Chicago')).toBe('2026-07-04T17:30')
  })
})
