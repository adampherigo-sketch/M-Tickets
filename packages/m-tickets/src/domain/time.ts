/**
 * Organizers type local wall-clock times ("2026-12-05T18:30") for the event's
 * time zone; the database stores instants. These convert between the two with
 * Intl only (no time zone library).
 */

function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** "2026-12-05T18:30" in America/New_York -> 2026-12-05T23:30:00Z */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const match = LOCAL.exec(local)
  if (!match) throw new Error(`Expected YYYY-MM-DDTHH:mm, got "${local}"`)
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number]
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi)
  const guess = wallAsUtc - offsetMs(new Date(wallAsUtc), timeZone)
  // Near a DST change the first guess can land on the other side; one more pass settles it.
  return new Date(wallAsUtc - offsetMs(new Date(guess), timeZone))
}

/** The inverse, for <input type="datetime-local"> values. */
export function utcToZonedLocal(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + offsetMs(instant, timeZone))
  return shifted.toISOString().slice(0, 16)
}

export function formatEventDateRange(startsAt: Date, endsAt: Date, timeZone: string, locale = 'en-US'): string {
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  const sameDay = date.format(startsAt) === date.format(endsAt)
  return sameDay
    ? `${date.format(startsAt)} · ${time.format(startsAt).replace(/ [A-Z]{2,5}$/, '')} – ${time.format(endsAt)}`
    : `${date.format(startsAt)} ${time.format(startsAt)} – ${date.format(endsAt)} ${time.format(endsAt)}`
}
