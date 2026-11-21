'use server'

/**
 * Organizer event actions. Each one re-checks the session and role; RLS is
 * the second line (owners/admins write events and ticket types).
 */
import {
  createEvent,
  createTicketType,
  deleteTicketType,
  getEvent,
  TicketsDbError,
  updateEvent,
  updateTicketType,
} from '@zevaryn/m-tickets/db'
import { OrganizerActionError, publishEvent, unpublishEvent } from '@zevaryn/m-tickets/server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireManager } from '@/lib/auth'
import { parseEventForm, parseTicketTypeForm, withMessage } from '@/lib/forms'
import { ticketsContext } from '@/lib/tickets'

function messageFor(error: unknown): string {
  if (error instanceof TicketsDbError) {
    if (error.code === 'duplicate_slug') return 'Another event already uses that link name.'
    if (error.code === 'in_use') return 'Tickets already exist for that ticket type, so it cannot be deleted.'
    if (error.code === 'forbidden') return 'You do not have permission to do that.'
  }
  if (error instanceof OrganizerActionError) return error.message
  console.error(error)
  return 'Something went wrong. Please try again.'
}

const editorPath = (eventId: string) => `/organizer/events/${eventId}`

export async function createEventAction(form: FormData): Promise<void> {
  const { supabase, membership } = await requireManager()
  const parsed = parseEventForm(form, membership.timezone)
  if (!parsed.ok) redirect(withMessage('/organizer/events/new', 'error', parsed.message))
  let eventId: string
  try {
    eventId = await createEvent(supabase, membership.tenantId, parsed.value)
  } catch (error) {
    redirect(withMessage('/organizer/events/new', 'error', messageFor(error)))
  }
  redirect(withMessage(editorPath(eventId), 'notice', 'Draft created. Add a ticket type, then publish.'))
}

export async function saveEventAction(eventId: string, form: FormData): Promise<void> {
  const { supabase, membership } = await requireManager()
  const parsed = parseEventForm(form, membership.timezone)
  if (!parsed.ok) redirect(withMessage(editorPath(eventId), 'error', parsed.message))
  try {
    await updateEvent(supabase, eventId, parsed.value)
  } catch (error) {
    redirect(withMessage(editorPath(eventId), 'error', messageFor(error)))
  }
  revalidatePath(editorPath(eventId))
  redirect(withMessage(editorPath(eventId), 'notice', 'Saved.'))
}

async function loadEventOrBack(eventId: string) {
  const ctx = await requireManager()
  const event = await getEvent(ctx.supabase, eventId)
  if (!event) redirect('/organizer/events')
  return { ...ctx, event }
}

export async function addTicketTypeAction(eventId: string, form: FormData): Promise<void> {
  const { supabase, event } = await loadEventOrBack(eventId)
  const parsed = parseTicketTypeForm(form, event.timezone)
  if (!parsed.ok) redirect(withMessage(editorPath(eventId), 'error', parsed.message))
  try {
    await createTicketType(supabase, event, parsed.value)
  } catch (error) {
    redirect(withMessage(editorPath(eventId), 'error', messageFor(error)))
  }
  redirect(withMessage(editorPath(eventId), 'notice', 'Ticket type added.'))
}

export async function updateTicketTypeAction(eventId: string, ticketTypeId: string, form: FormData): Promise<void> {
  const { supabase, event } = await loadEventOrBack(eventId)
  const parsed = parseTicketTypeForm(form, event.timezone)
  if (!parsed.ok) redirect(withMessage(editorPath(eventId), 'error', parsed.message))
  try {
    await updateTicketType(supabase, ticketTypeId, parsed.value)
  } catch (error) {
    redirect(withMessage(editorPath(eventId), 'error', messageFor(error)))
  }
  redirect(withMessage(editorPath(eventId), 'notice', 'Ticket type saved.'))
}

export async function deleteTicketTypeAction(eventId: string, ticketTypeId: string): Promise<void> {
  const { supabase } = await loadEventOrBack(eventId)
  try {
    await deleteTicketType(supabase, ticketTypeId)
  } catch (error) {
    redirect(withMessage(editorPath(eventId), 'error', messageFor(error)))
  }
  redirect(withMessage(editorPath(eventId), 'notice', 'Ticket type deleted.'))
}

export async function publishEventAction(eventId: string): Promise<void> {
  const { supabase } = await requireManager()
  let result: Awaited<ReturnType<typeof publishEvent>>
  try {
    result = await publishEvent(ticketsContext(), supabase, eventId)
  } catch (error) {
    redirect(withMessage(editorPath(eventId), 'error', messageFor(error)))
  }
  if (!result.ok) redirect(withMessage(editorPath(eventId), 'error', result.messages.join(' ')))
  redirect(withMessage(editorPath(eventId), 'notice', 'Published. Your event is live on your ticket page.'))
}

export async function unpublishEventAction(eventId: string): Promise<void> {
  const { supabase } = await requireManager()
  try {
    await unpublishEvent(ticketsContext(), supabase, eventId)
  } catch (error) {
    redirect(withMessage(editorPath(eventId), 'error', messageFor(error)))
  }
  redirect(withMessage(editorPath(eventId), 'notice', 'Unpublished. Existing tickets stay valid.'))
}
