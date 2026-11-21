import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export type { Database, Json, Tables, TablesInsert, TablesUpdate, Enums } from './database.types'
export { Constants } from './database.types'

/** A Supabase client typed against the whole M-System schema. */
export type DbClient = SupabaseClient<Database>
