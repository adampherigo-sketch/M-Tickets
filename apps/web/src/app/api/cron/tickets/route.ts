import { runTicketsCron } from '@zevaryn/m-tickets/server'
import { NextResponse, type NextRequest } from 'next/server'
import { serverEnv } from '@/lib/env'
import { ticketsContext, ticketsSenders } from '@/lib/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Constant-time comparison, so the secret cannot be guessed byte by byte from timings. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/**
 * M-Tickets cron, every 5 minutes: release seats held by abandoned checkouts,
 * purge leftover delivery rows, and send queued confirmations and thank-yous
 * (including retries). Call with "Authorization: Bearer <CRON_SECRET>".
 * Vercel Cron sends that header itself when CRON_SECRET is set.
 */
export async function GET(request: NextRequest) {
  const secret = serverEnv().CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 })
  const header = request.headers.get('authorization') ?? ''
  if (!sameSecret(header, `Bearer ${secret}`)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await runTicketsCron(ticketsContext(), ticketsSenders())
    return NextResponse.json(result)
  } catch (error) {
    console.error('[m-tickets] cron failed', error)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}
