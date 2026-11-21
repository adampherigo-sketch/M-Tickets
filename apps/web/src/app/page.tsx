import Link from 'next/link'

export default function Home() {
  return (
    <main className="mt-page mt-narrow">
      <h1>M-Tickets</h1>
      <p>RSVPs, ticket sales and guest lists, part of M-System by Zevaryn Systems.</p>
      <div className="mt-actions">
        <Link className="mt-button mt-button--primary" href="/organizer">
          Organizer sign in
        </Link>
        <Link className="mt-button" href="/t/demo-co">
          Demo ticket page
        </Link>
      </div>
    </main>
  )
}
