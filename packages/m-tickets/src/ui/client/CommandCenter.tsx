'use client'

/**
 * Day-of operations for one event: live tally, check-in by camera or typed
 * code, searchable guest list, and the thank-attendees action.
 *
 * Endpoints are passed in so this component does not know the app's routes:
 *   checkInUrl    POST { eventId, input } -> CheckInFeedback
 *   attendeesUrl  GET -> { attendees: AttendeeView[] }   (polled for the live tally)
 */
import { useActionState, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { formatTicketCode, normalizeTicketCode, tallyAttendance } from '../../domain'
import { Stat, STATUS_LABELS } from '../components'
import { QrScanner } from './QrScanner'
import type { AttendeeView, CheckInFeedback, ThankYouState } from './types'

const POLL_MS = 5000

type Filter = 'all' | 'arrived' | 'not_arrived'

export interface CommandCenterProps {
  eventId: string
  checkInUrl: string
  attendeesUrl: string
  initialAttendees: AttendeeView[]
  ticketTypes: { id: string; name: string }[]
  /** Omit for staff (owners and admins only). */
  thankAttendeesAction?: (state: ThankYouState, formData: FormData) => Promise<ThankYouState>
}

export function CommandCenter(props: CommandCenterProps) {
  const { eventId, checkInUrl, attendeesUrl, ticketTypes, thankAttendeesAction } = props
  const [attendees, setAttendees] = useState(props.initialAttendees)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [typeFilter, setTypeFilter] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [feedback, setFeedback] = useState<CheckInFeedback | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(attendeesUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as { attendees: AttendeeView[] }
      setAttendees(body.attendees)
      setStale(false)
    } catch {
      setStale(true)
    }
  }, [attendeesUrl])

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const submitCheckIn = useCallback(
    async (input: string) => {
      if (!input.trim()) return
      setBusy(true)
      try {
        const response = await fetch(checkInUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventId, input }),
        })
        const body = (await response.json()) as CheckInFeedback | { error: string }
        setFeedback(
          'error' in body
            ? { result: 'invalid_input', message: body.error, attendeeName: null, ticketTypeName: null }
            : body,
        )
        await refresh()
      } catch {
        setFeedback({
          result: 'invalid_input',
          message: 'Network error. Try again.',
          attendeeName: null,
          ticketTypeName: null,
        })
      } finally {
        setBusy(false)
      }
    },
    [checkInUrl, eventId, refresh],
  )

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const input = codeInput
    setCodeInput('')
    void submitCheckIn(input)
  }

  const tally = useMemo(() => tallyAttendance(attendees), [attendees])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const code = normalizeTicketCode(query)
    return attendees.filter((a) => {
      if (typeFilter && a.ticketTypeId !== typeFilter) return false
      if (filter === 'arrived' && a.status !== 'checked_in') return false
      if (filter === 'not_arrived' && a.status !== 'valid') return false
      if (!needle) return true
      return (
        a.attendeeName.toLowerCase().includes(needle) ||
        (a.attendeeEmail ?? '').toLowerCase().includes(needle) ||
        a.buyerEmail.toLowerCase().includes(needle) ||
        (code !== null && a.ticketCode === code)
      )
    })
  }, [attendees, query, filter, typeFilter])

  return (
    <div className="mt-command">
      <section className="mt-tally" aria-label="Attendance">
        <Stat label="arrived" value={tally.checkedIn} />
        <Stat label="not here yet" value={tally.notArrived} />
        <Stat label="expected" value={tally.expected} />
        <div
          className="mt-progress"
          role="progressbar"
          aria-valuenow={tally.percentArrived}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="mt-progress__bar" style={{ width: `${tally.percentArrived}%` }} />
        </div>
        {stale ? <p className="mt-muted">Live updates paused (offline?). Retrying…</p> : null}
      </section>

      <section className="mt-card" aria-label="Check in">
        <h2>Check in</h2>
        <QrScanner onScan={(payload) => void submitCheckIn(payload)} />
        <form onSubmit={onSubmit} className="mt-row">
          <label className="mt-field mt-grow">
            <span>Ticket code</span>
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="ABCDE-12345"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="mt-button mt-button--primary" disabled={busy}>
            Check in
          </button>
        </form>
        {feedback ? (
          <p className={`mt-feedback mt-feedback--${feedback.result}`} role="status">
            <strong>{feedback.message}</strong>
            {feedback.attendeeName ? ` · ${feedback.attendeeName}` : ''}
            {feedback.ticketTypeName ? ` (${feedback.ticketTypeName})` : ''}
          </p>
        ) : null}
      </section>

      <section className="mt-card" aria-label="Guest list">
        <h2>Guest list</h2>
        <div className="mt-row mt-wrap">
          <label className="mt-field mt-grow">
            <span>Search</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email or code" />
          </label>
          <label className="mt-field">
            <span>Show</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">Everyone</option>
              <option value="arrived">Arrived</option>
              <option value="not_arrived">Not arrived</option>
            </select>
          </label>
          <label className="mt-field">
            <span>Ticket type</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {ticketTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-muted">
          Showing {visible.length} of {attendees.length}
        </p>
        <div className="mt-table-wrap">
          <table className="mt-table">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Ticket</th>
                <th>Code</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.ticketId}>
                  <td>
                    {a.attendeeName}
                    <br />
                    <span className="mt-muted">{a.attendeeEmail ?? a.buyerEmail}</span>
                  </td>
                  <td>{a.ticketTypeName}</td>
                  <td>
                    <code className="mt-code">{formatTicketCode(a.ticketCode)}</code>
                  </td>
                  <td>
                    <span className={`mt-badge mt-badge--${a.status}`}>
                      {a.status === 'checked_in' && a.checkedInAt
                        ? `In ${new Date(a.checkedInAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                        : STATUS_LABELS[a.status]}
                    </span>
                  </td>
                  <td>
                    {a.status === 'valid' ? (
                      <button
                        type="button"
                        className="mt-button"
                        disabled={busy}
                        onClick={() => void submitCheckIn(a.ticketCode)}
                      >
                        Check in
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {thankAttendeesAction ? <ThankAttendees action={thankAttendeesAction} arrived={tally.checkedIn} /> : null}
    </div>
  )
}

function ThankAttendees({
  action,
  arrived,
}: {
  action: (state: ThankYouState, formData: FormData) => Promise<ThankYouState>
  arrived: number
}) {
  const [state, formAction, pending] = useActionState(action, { message: null })
  return (
    <section className="mt-card" aria-label="Thank attendees">
      <h2>After the event</h2>
      <p className="mt-muted">
        Queues a thank-you email to each of the {arrived} guests who checked in. Each guest gets one.
      </p>
      <form action={formAction}>
        <button type="submit" className="mt-button" disabled={pending || arrived === 0}>
          {pending ? 'Queuing…' : 'Thank attendees'}
        </button>
      </form>
      {state.message ? <p role="status">{state.message}</p> : null}
    </section>
  )
}
