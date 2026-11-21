/**
 * Generates packages/database/src/database.types.ts from every package's
 * supabase/migrations, without Docker. Adapted from Zevaryn Home's generator.
 *
 * It applies the migrations to PGlite, introspects the public schema and writes
 * types in the same shape as `supabase gen types typescript`, so the app code is
 * identical whichever generator ran last. With the Supabase CLI and a running
 * local stack, `npm run db:types` produces the canonical file instead.
 *
 * Usage: npm run db:types:offline
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPglite, repoRoot } from '../testing/pglite'

interface ColumnRow {
  relation: string
  relkind: string
  name: string
  typname: string
  typtype: string
  elem_typname: string | null
  elem_typtype: string | null
  nullable: boolean
  has_default: boolean
  identity: string
  generated: string
}

interface ForeignKeyRow {
  name: string
  relation: string
  referenced_relation: string
  columns: string[]
  referenced_columns: string[]
  one_to_one: boolean
}

interface FunctionRow {
  name: string
  arg_names: string[] | null
  arg_modes: string[] | null
  arg_types: string[]
  all_arg_types: string[] | null
  default_count: number
  returns_set: boolean
  ret_typname: string
  ret_typtype: string
  ret_elem_typname: string | null
  ret_elem_typtype: string | null
}

interface TypeRow {
  typname: string
  typtype: string
  elem_typname: string | null
  elem_typtype: string | null
}

const NUMBER = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'oid'])
const STRING = new Set([
  'text',
  'varchar',
  'bpchar',
  'char',
  'name',
  'uuid',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'citext',
  'inet',
  'cidr',
  'macaddr',
  'bytea',
  'tsvector',
])

function tsType(typname: string, typtype: string, elemTypname: string | null, elemTyptype: string | null): string {
  if (elemTypname && elemTyptype) return `${tsType(elemTypname, elemTyptype, null, null)}[]`
  if (typtype === 'e') return `Database["public"]["Enums"]["${typname}"]`
  if (typname === 'bool') return 'boolean'
  if (NUMBER.has(typname)) return 'number'
  if (STRING.has(typname)) return 'string'
  if (typname === 'json' || typname === 'jsonb') return 'Json'
  if (typname === 'void') return 'undefined'
  return 'unknown'
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n')
}

const db = await openPglite()

const columns = (
  await db.query<ColumnRow>(`
    select c.relname as relation, c.relkind::text as relkind, a.attname as name,
           t.typname, t.typtype::text as typtype,
           et.typname as elem_typname, et.typtype::text as elem_typtype,
           not a.attnotnull as nullable, a.atthasdef as has_default,
           a.attidentity::text as identity, a.attgenerated::text as generated
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid
    left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `)
).rows

const foreignKeys = (
  await db.query<ForeignKeyRow>(`
    select con.conname as name, src.relname as relation, tgt.relname as referenced_relation,
           array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord) as columns,
           array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord) as referenced_columns,
           exists (select 1 from pg_index i
                   where i.indrelid = con.conrelid and i.indisunique and i.indpred is null
                     and i.indkey::int2[] @> con.conkey and con.conkey @> i.indkey::int2[]) as one_to_one
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace sn on sn.oid = src.relnamespace
    join pg_namespace tn on tn.oid = tgt.relnamespace
    where con.contype = 'f' and sn.nspname = 'public' and tn.nspname = 'public'
    order by src.relname, con.conname
  `)
).rows

const enums = (
  await db.query<{ name: string; values: string[] }>(`
    select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    group by t.typname
    order by t.typname
  `)
).rows

const functions = (
  await db.query<FunctionRow>(`
    select p.proname as name, p.proargnames::text[] as arg_names, p.proargmodes::text[] as arg_modes,
           array(select t::regtype::text from unnest(p.proargtypes::oid[]) t) as arg_types,
           array(select t::regtype::text from unnest(p.proallargtypes) t) as all_arg_types,
           p.pronargdefaults::int as default_count, p.proretset as returns_set,
           rt.typname as ret_typname, rt.typtype::text as ret_typtype,
           ret.typname as ret_elem_typname, ret.typtype::text as ret_elem_typtype
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
    left join pg_type ret on ret.oid = rt.typelem and rt.typcategory = 'A'
    where n.nspname = 'public' and p.prokind = 'f'
    order by p.proname
  `)
).rows

/** Resolves a regtype name (e.g. "member_role[]", "timestamp with time zone") to a TS type. */
async function typeFromRegtype(regtype: string): Promise<string> {
  const { rows } = await db.query<TypeRow>(
    `select t.typname, t.typtype::text as typtype, et.typname as elem_typname, et.typtype::text as elem_typtype
     from pg_type t left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
     where t.oid = $1::regtype`,
    [regtype],
  )
  const row = rows[0]
  if (!row) return 'unknown'
  return tsType(row.typname, row.typtype, row.elem_typname, row.elem_typtype)
}

const relations = [...new Set(columns.map((c) => c.relation))]
const tables = relations.filter((r) => columns.find((c) => c.relation === r)!.relkind !== 'v')
const views = relations.filter((r) => columns.find((c) => c.relation === r)!.relkind === 'v')

function relationshipsBlock(relation: string): string {
  const keys = foreignKeys.filter((fk) => fk.relation === relation)
  if (keys.length === 0) return 'Relationships: []'
  const entries = keys.map(
    (fk) => `{
  foreignKeyName: "${fk.name}"
  columns: [${fk.columns.map((c) => `"${c}"`).join(', ')}]
  isOneToOne: ${fk.one_to_one}
  referencedRelation: "${fk.referenced_relation}"
  referencedColumns: [${fk.referenced_columns.map((c) => `"${c}"`).join(', ')}]
},`,
  )
  return `Relationships: [\n${indent(entries.join('\n'), 2)}\n]`
}

function tableBlock(relation: string): string {
  const cols = columns.filter((c) => c.relation === relation)
  const typeOf = (c: ColumnRow) => tsType(c.typname, c.typtype, c.elem_typname, c.elem_typtype)
  const row = cols.map((c) => `${c.name}: ${typeOf(c)}${c.nullable ? ' | null' : ''}`)
  const insert = cols.map((c) => {
    if (c.identity === 'a' || c.generated === 's') return `${c.name}?: never`
    const optional = c.nullable || c.has_default || c.identity === 'd'
    return `${c.name}${optional ? '?' : ''}: ${typeOf(c)}${c.nullable ? ' | null' : ''}`
  })
  const update = cols.map((c) => {
    if (c.identity === 'a' || c.generated === 's') return `${c.name}?: never`
    return `${c.name}?: ${typeOf(c)}${c.nullable ? ' | null' : ''}`
  })
  return `${relation}: {
  Row: {
${indent(row.join('\n'), 4)}
  }
  Insert: {
${indent(insert.join('\n'), 4)}
  }
  Update: {
${indent(update.join('\n'), 4)}
  }
${indent(relationshipsBlock(relation), 2)}
}`
}

function viewBlock(relation: string): string {
  const cols = columns.filter((c) => c.relation === relation)
  const row = cols.map((c) => `${c.name}: ${tsType(c.typname, c.typtype, c.elem_typname, c.elem_typtype)} | null`)
  return `${relation}: {
  Row: {
${indent(row.join('\n'), 4)}
  }
  Relationships: []
}`
}

async function functionBlock(fn: FunctionRow): Promise<string> {
  // proallargtypes is null when every argument is an input, which array() turns into [].
  const modes = fn.arg_modes ?? fn.arg_types.map(() => 'i')
  const allTypes = fn.all_arg_types?.length ? fn.all_arg_types : fn.arg_types
  const names = fn.arg_names ?? []
  const inputs: Array<{ name: string; type: string }> = []
  const outputs: Array<{ name: string; type: string }> = []
  for (let i = 0; i < modes.length; i += 1) {
    const entry = { name: names[i] ?? `arg${i}`, type: await typeFromRegtype(allTypes[i]!) }
    if (modes[i] === 'i' || modes[i] === 'b') inputs.push(entry)
    if (modes[i] === 't' || modes[i] === 'o' || modes[i] === 'b') outputs.push(entry)
  }
  const firstOptional = inputs.length - fn.default_count
  const args =
    inputs.length === 0
      ? 'Args: never'
      : `Args: {\n${indent(inputs.map((a, i) => `${a.name}${i >= firstOptional ? '?' : ''}: ${a.type}`).join('\n'), 2)}\n}`

  let returns: string
  if (outputs.length > 0) {
    returns = `Returns: {\n${indent(outputs.map((o) => `${o.name}: ${o.type}`).join('\n'), 2)}\n}${fn.returns_set ? '[]' : ''}`
  } else {
    const base = tsType(fn.ret_typname, fn.ret_typtype, fn.ret_elem_typname, fn.ret_elem_typtype)
    returns = `Returns: ${base}${fn.returns_set ? '[]' : ''}`
  }
  return `${fn.name}: {\n${indent(args, 2)}\n${indent(returns, 2)}\n}`
}

const functionBlocks = await Promise.all(functions.map(functionBlock))
await db.close()

const enumBlocks = enums.map((e) => `${e.name}: ${e.values.map((v) => `"${v}"`).join(' | ')}`)
const constantBlocks = enums.map((e) => `${e.name}: [${e.values.map((v) => `"${v}"`).join(', ')}],`)

const output = `// Generated by packages/database/scripts/gen-types.ts from the package migrations. Do not edit.
// Regenerate with \`npm run db:types:offline\` (no Docker) or \`npm run db:types\` (Supabase CLI).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "12"
  }
  public: {
    Tables: {
${indent(tables.map(tableBlock).join('\n'), 6)}
    }
    Views: {
${indent(views.map(viewBlock).join('\n'), 6)}
    }
    Functions: {
${indent(functionBlocks.join('\n'), 6)}
    }
    Enums: {
${indent(enumBlocks.join('\n'), 6)}
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
${indent(constantBlocks.join('\n'), 6)}
    },
  },
} as const
`

const target = join(repoRoot, 'packages', 'database', 'src', 'database.types.ts')
writeFileSync(target, output)
console.log(
  `Wrote ${target} (${tables.length} tables, ${views.length} views, ${functions.length} functions, ${enums.length} enums)`,
)
