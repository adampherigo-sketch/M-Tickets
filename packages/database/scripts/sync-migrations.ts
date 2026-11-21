/**
 * Copies every package's migrations into supabase/migrations (what the Supabase
 * CLI reads). With --check, changes nothing and exits 1 if the copy is stale.
 *
 * Usage: npm run db:migrations:sync | npm run db:migrations:check
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { packageMigrations, rootMigrationNames, rootMigrationsDir } from '../src/migrations'

const check = process.argv.includes('--check')
const sources = packageMigrations()
const targetDir = rootMigrationsDir()
const existing = new Set(rootMigrationNames())
const problems: string[] = []

for (const source of sources) {
  const target = join(targetDir, source.filename)
  const same = existing.has(source.filename) && readFileSync(target, 'utf8') === readFileSync(source.path, 'utf8')
  existing.delete(source.filename)
  if (same) continue
  if (check) {
    problems.push(`${source.owner}/${source.filename} is missing or different in supabase/migrations`)
  } else {
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(source.path, target)
    console.log(`copied ${source.owner}/${source.filename}`)
  }
}

for (const orphan of existing) {
  if (check) {
    problems.push(`supabase/migrations/${orphan} has no source in packages/*/supabase/migrations`)
  } else {
    rmSync(join(targetDir, orphan))
    console.log(`removed ${orphan} (no package owns it)`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  console.error('Run `npm run db:migrations:sync` and commit the result.')
  process.exit(1)
}
console.log(check ? `supabase/migrations is in sync (${sources.length} files)` : 'supabase/migrations is up to date')
