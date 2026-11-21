/**
 * Each package owns its migrations in packages/<name>/supabase/migrations.
 * Filenames start with a UTC timestamp, so sorting by filename across packages
 * gives the one global order the shared database applies them in.
 *
 * The Supabase CLI and its GitHub integration only read supabase/migrations at
 * the repo root, so `npm run db:migrations:sync` copies package migrations
 * there, and `npm run db:migrations:check` (part of `npm run check`) fails when
 * the copy has drifted.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export const repoRoot = join(import.meta.dirname, '..', '..', '..')

export interface MigrationFile {
  /** Package that owns the migration, e.g. "m-tickets". */
  owner: string
  filename: string
  path: string
}

const FILENAME = /^\d{14}_[a-z0-9_]+\.sql$/

export function packageMigrations(root: string = repoRoot): MigrationFile[] {
  const packagesDir = join(root, 'packages')
  const files: MigrationFile[] = []
  for (const owner of readdirSync(packagesDir)) {
    const dir = join(packagesDir, owner, 'supabase', 'migrations')
    if (!existsSync(dir)) continue
    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith('.sql')) continue
      if (!FILENAME.test(filename)) {
        throw new Error(`Migration ${owner}/${filename} must be named <14-digit UTC timestamp>_<snake_case>.sql`)
      }
      files.push({ owner, filename, path: join(dir, filename) })
    }
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename))
  for (let i = 1; i < files.length; i += 1) {
    const previous = files[i - 1]!
    const current = files[i]!
    if (previous.filename.slice(0, 14) === current.filename.slice(0, 14)) {
      throw new Error(
        `Migrations ${previous.owner}/${previous.filename} and ${current.owner}/${current.filename} share a timestamp`,
      )
    }
  }
  return files
}

export function rootMigrationsDir(root: string = repoRoot): string {
  return join(root, 'supabase', 'migrations')
}

export function rootMigrationNames(root: string = repoRoot): string[] {
  const dir = rootMigrationsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => basename(file))
    .sort()
}
