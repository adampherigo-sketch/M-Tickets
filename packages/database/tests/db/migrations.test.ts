import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageMigrations, rootMigrationNames, rootMigrationsDir } from '../../src/migrations'

describe('migrations', () => {
  it('supabase/migrations matches the package migrations exactly (run npm run db:migrations:sync)', () => {
    const sources = packageMigrations()
    expect(rootMigrationNames()).toEqual(sources.map((s) => s.filename))
    for (const source of sources) {
      expect(readFileSync(join(rootMigrationsDir(), source.filename), 'utf8'), source.filename).toBe(
        readFileSync(source.path, 'utf8'),
      )
    }
  })

  it('core runs before every module', () => {
    const owners = packageMigrations().map((m) => m.owner)
    expect(owners[0]).toBe('core')
  })
})
