/**
 * npm run db:seed
 *
 * Loads apps/web/.env.local (for TICKETS_QR_SECRET and SUPABASE_DB_URL), then
 * seeds the demo tenant into the local Supabase Postgres. Refuses anything
 * that is not a local database.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { formatTicketCode } from '../src/domain'
import { DEMO, seedDemo } from './demo'

const envFile = join(import.meta.dirname, '..', '..', '..', 'apps', 'web', '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const databaseUrl = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const qrSecret = process.env.TICKETS_QR_SECRET ?? ''
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(databaseUrl)) {
  console.error('Refusing to seed a non-local database. The demo seed is for local development only.')
  process.exit(1)
}
if (qrSecret.length < 32 || qrSecret.startsWith('replace-with')) {
  console.error('Set TICKETS_QR_SECRET (32+ characters) in apps/web/.env.local first.')
  process.exit(1)
}

const client = new pg.Client({ connectionString: databaseUrl })
await client.connect()
try {
  await client.query('begin')
  const summary = await seedDemo({ query: async (sql, params) => (await client.query(sql, params)).rows }, { qrSecret })
  await client.query('commit')
  if (!summary) {
    console.log(`Demo tenant "${DEMO.tenantSlug}" already exists. Run \`npm run db:reset\` for a clean slate.`)
  } else {
    console.log('Seeded the M-Tickets demo.\n')
    console.log(`  Public page:   ${appUrl}/t/${DEMO.tenantSlug}`)
    console.log(`  Organizer:     ${DEMO.ownerEmail} / ${DEMO.password}`)
    console.log(`  Door staff:    ${DEMO.staffEmail} / ${DEMO.password}\n`)
    for (const order of summary.orders) {
      console.log(`  ${order.buyer}: ${appUrl}${order.orderPath}`)
      for (const ticket of order.tickets)
        console.log(`      ${formatTicketCode(ticket.code)}  ${ticket.attendee} (${ticket.status})`)
    }
  }
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  await client.end()
}
