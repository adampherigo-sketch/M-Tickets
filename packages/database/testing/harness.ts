/**
 * Database test harness, shared by every module's tests/db suite.
 *
 * By default each test file gets a fresh PGlite with every migration applied,
 * so the suite needs no Docker. Set TEST_DATABASE_URL to run the same tests
 * against a real Supabase Postgres (`npm run db:start`, port 54322), where the
 * CLI has already applied the migrations.
 *
 * Every test runs inside a transaction that is rolled back afterwards.
 */
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { openPglite } from './pglite'

export type Row = Record<string, unknown>

/** The minimal SQL surface both backends (and the seed script) share. */
export interface SqlClient {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends SqlClient {
  readonly backend: 'pglite' | 'postgres'
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

export async function openDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL
  if (url) {
    pg.types.setTypeParser(20, Number)
    pg.types.setTypeParser(1700, Number)
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    return {
      backend: 'postgres',
      async query<T extends Row>(sql: string, params: unknown[] = []) {
        const result = await client.query(sql, params)
        return result.rows as T[]
      },
      async exec(sql: string) {
        await client.query(sql)
      },
      async close() {
        await client.end()
      },
    }
  }

  const db = await openPglite()
  return {
    backend: 'pglite',
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params)
      return result.rows
    },
    async exec(sql: string) {
      await db.exec(sql)
    },
    async close() {
      await db.close()
    },
  }
}

/** Registers vitest hooks: one database per file, one rolled-back transaction per test. */
export function setupDb(): () => Db {
  let db: Db | undefined
  beforeAll(async () => {
    db = await openDb()
  }, 120_000)
  afterAll(async () => {
    await db?.close()
  })
  beforeEach(async () => {
    await db!.exec('begin')
  })
  afterEach(async () => {
    await db!.exec('rollback')
  })
  return () => {
    if (!db) throw new Error('Database not open yet')
    return db
  }
}

// Sessions. Supabase identifies the caller through request.jwt.claims; RLS and
// auth.uid() read it exactly as they do behind PostgREST.

/** Back to the postgres superuser (fixtures, admin checks). */
export async function actAsAdmin(db: Db): Promise<void> {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', '', true)`)
}

export async function actAs(db: Db, userId: string): Promise<void> {
  await db.exec('reset role')
  const claims = { sub: userId, role: 'authenticated', aal: 'aal1' }
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
  await db.exec('set local role authenticated')
}

export async function actAsAnon(db: Db): Promise<void> {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
  await db.exec('set local role anon')
}

export async function actAsService(db: Db): Promise<void> {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })])
  await db.exec('set local role service_role')
}

/** Runs `run` inside a savepoint and asserts it fails with a matching message. */
export async function expectDbError(db: Db, run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await db.exec('savepoint expect_db_error')
  let failure: unknown
  try {
    await run()
  } catch (error) {
    failure = error
  }
  await db.exec('rollback to savepoint expect_db_error')
  if (failure === undefined) {
    throw new Error(`Expected a database error matching ${pattern}, but the statement succeeded`)
  }
  expect(failure instanceof Error ? failure.message : String(failure)).toMatch(pattern)
}

let userCounter = 0

export async function createUser(db: SqlClient, label: string): Promise<string> {
  userCounter += 1
  const email = `${label}.${Date.now()}.${userCounter}@zevaryn.test`
  const [row] = await db.query<{ id: string }>(
    `insert into auth.users (id, email, aud, role)
     values (gen_random_uuid(), $1, 'authenticated', 'authenticated')
     returning id`,
    [email],
  )
  return row!.id
}
