import Link from 'next/link'
import type { ReactNode } from 'react'

// Every organizer page depends on the signed-in session.
export const dynamic = 'force-dynamic'

/**
 * Chrome only. Each page calls requireOrganizer() itself (layouts are not a
 * security boundary in the App Router), and the setup page must render for
 * users who have no tenant yet.
 */
export default function OrganizerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="mt-topbar">
        <span className="mt-topbar__brand">M-Tickets</span>
        <nav aria-label="Organizer">
          <Link href="/organizer/events">Events</Link>
          <Link href="/organizer/payments">Payments</Link>
        </nav>
        <form action="/auth/signout" method="post">
          <button type="submit" className="mt-button">
            Sign out
          </button>
        </form>
      </header>
      {children}
    </>
  )
}
