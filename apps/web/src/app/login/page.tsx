import type { Metadata } from 'next'
import { Banners, param, type SearchParams } from '../messages'
import { signIn } from './actions'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  return (
    <main className="mt-page mt-narrow">
      <h1>Organizer sign in</h1>
      <Banners params={params} />
      <form action={signIn} className="mt-card mt-stack">
        <input type="hidden" name="next" value={param(params, 'next') ?? '/organizer'} />
        <label className="mt-field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="mt-field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" className="mt-button mt-button--primary">
          Sign in
        </button>
      </form>
      <p className="mt-muted">Accounts are set up by Zevaryn Systems. Local demo: see the README.</p>
    </main>
  )
}
