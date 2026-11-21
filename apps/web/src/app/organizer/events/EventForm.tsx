import type { OrganizerEvent } from '@zevaryn/m-tickets/db'
import { utcToZonedLocal } from '@zevaryn/m-tickets/domain'

/** Event details form, shared by "new" and "edit". Times are in the event's time zone. */
export function EventForm({
  action,
  event,
  defaultTimezone,
  submitLabel,
}: {
  action: (form: FormData) => Promise<void>
  event?: OrganizerEvent
  defaultTimezone: string
  submitLabel: string
}) {
  const timezone = event?.timezone ?? defaultTimezone
  return (
    <form action={action} className="mt-card mt-stack">
      <h2>Details</h2>
      <label className="mt-field">
        <span>Title</span>
        <input name="title" defaultValue={event?.title} required maxLength={200} />
      </label>
      <label className="mt-field">
        <span>Link name (leave blank to use the title)</span>
        <input name="slug" defaultValue={event?.slug} maxLength={80} placeholder="spring-open-house" />
      </label>
      <label className="mt-field">
        <span>Description</span>
        <textarea name="description" defaultValue={event?.description} maxLength={10000} />
      </label>
      <div className="mt-grid">
        <label className="mt-field">
          <span>Venue</span>
          <input name="venueName" defaultValue={event?.venueName ?? ''} maxLength={200} />
        </label>
        <label className="mt-field">
          <span>Address</span>
          <input name="venueAddress" defaultValue={event?.venueAddress ?? ''} maxLength={500} />
        </label>
      </div>
      <div className="mt-grid">
        <label className="mt-field">
          <span>Starts</span>
          <input
            type="datetime-local"
            name="startsAt"
            required
            defaultValue={event ? utcToZonedLocal(event.startsAt, timezone) : undefined}
          />
        </label>
        <label className="mt-field">
          <span>Ends</span>
          <input
            type="datetime-local"
            name="endsAt"
            required
            defaultValue={event ? utcToZonedLocal(event.endsAt, timezone) : undefined}
          />
        </label>
        <label className="mt-field">
          <span>Time zone</span>
          <input name="timezone" defaultValue={timezone} required />
        </label>
      </div>
      <label className="mt-check">
        <input type="checkbox" name="showPublicCounts" defaultChecked={event?.showPublicCounts ?? false} />
        Show how many people have RSVP&apos;d and how many tickets sold on the public page
      </label>
      <div>
        <button type="submit" className="mt-button mt-button--primary">
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
