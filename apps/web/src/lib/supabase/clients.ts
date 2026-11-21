import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { Database, DbClient } from '@zevaryn/database'
import { cookies } from 'next/headers'
import { publicEnv, serverEnv } from '../env'

/**
 * Three clients, three trust levels:
 *
 *   userClient()     the signed-in organizer's session. RLS applies. Default.
 *   publicClient()   anonymous. Can only call the tickets_public_* functions.
 *   serviceClient()  service role. Bypasses RLS. Only the M-Tickets server
 *                    layer (orders, webhooks, payment accounts) uses it.
 */
export async function userClient(): Promise<DbClient> {
  const env = publicEnv()
  const cookieStore = await cookies()
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy refreshes the session on the next request instead.
        }
      },
    },
  })
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

let publicSingleton: DbClient | undefined
let serviceSingleton: DbClient | undefined

export function publicClient(): DbClient {
  const env = publicEnv()
  publicSingleton ??= createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, noSession)
  return publicSingleton
}

export function serviceClient(): DbClient {
  serviceSingleton ??= createClient<Database>(
    publicEnv().NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    noSession,
  )
  return serviceSingleton
}
