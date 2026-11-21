import { join } from 'node:path'
import type { NextConfig } from 'next'

const monorepoRoot = join(import.meta.dirname, '..', '..')

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: ['@zevaryn/core', '@zevaryn/database', '@zevaryn/m-tickets'],
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The command page needs the camera for QR check-in; nothing else does.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        ],
      },
      {
        // Ticket links carry a bearer token in the path: never leak it onward.
        source: '/t/:client/orders/:token',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
    ]
  },
}

export default config
