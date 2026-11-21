import { NextResponse, type NextRequest } from 'next/server'
import { userClient } from '@/lib/supabase/clients'

export async function POST(request: NextRequest) {
  const supabase = await userClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
}
