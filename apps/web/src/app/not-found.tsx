import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="mt-page mt-narrow">
      <h1>Not found</h1>
      <p>That page does not exist, or the event is not published.</p>
      <Link href="/">Home</Link>
    </main>
  )
}
