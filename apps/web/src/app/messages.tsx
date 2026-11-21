/** Error and notice banners driven by ?error= / ?notice= query params. */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>

export function param(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

const NOTICES: Record<string, string> = {
  'managers-only': 'Only owners and admins can open that page.',
}

export function Banners({ params }: { params: Record<string, string | string[] | undefined> }) {
  const error = param(params, 'error')
  const notice = param(params, 'notice')
  return (
    <>
      {error ? (
        <p className="mt-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-notice" role="status">
          {NOTICES[notice] ?? notice}
        </p>
      ) : null}
    </>
  )
}
