/**
 * A PGlite (Postgres compiled to WASM) with a small Supabase stand-in and every
 * package migration applied, in global timestamp order. Shared by the database
 * tests and scripts/gen-types.ts, so it must not import vitest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite, types } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { packageMigrations } from '../src/migrations'

export { repoRoot } from '../src/migrations'

export async function openPglite(): Promise<PGlite> {
  const db = await PGlite.create({
    extensions: { pgcrypto },
    // bigint and numeric come back as JS numbers, as they do through PostgREST.
    parsers: { [types.INT8]: Number, [types.NUMERIC]: Number },
  })
  await db.exec(readFileSync(join(import.meta.dirname, 'supabase-shim.sql'), 'utf8'))
  for (const migration of packageMigrations()) {
    try {
      await db.exec(readFileSync(migration.path, 'utf8'))
    } catch (error) {
      throw new Error(`Migration ${migration.owner}/${migration.filename} failed: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }
  return db
}
