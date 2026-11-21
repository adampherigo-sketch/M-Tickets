import { runHousekeeping, type HousekeepingResult } from '../db'
import type { TicketsContext } from './context'
import { dispatchMessages, type DispatchSummary, type MessageSenders } from './messaging'

/**
 * The cron job, every few minutes: release holds whose checkout was abandoned
 * without a webhook, purge leftover delivery rows, then send what is due.
 */
export async function runTicketsCron(
  ctx: TicketsContext,
  senders: MessageSenders,
): Promise<HousekeepingResult & { messages: DispatchSummary }> {
  const housekeeping = await runHousekeeping(ctx.service)
  const messages = await dispatchMessages(ctx, senders, { limit: 50 })
  return { ...housekeeping, messages }
}
