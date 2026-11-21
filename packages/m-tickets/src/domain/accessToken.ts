/**
 * Buyer ticket links (/t/<client>/orders/<token>). The token is 256 random
 * bits; only its SHA-256 is stored, so a database leak does not leak links.
 */
import { cryptoRandomBytes, type RandomBytes } from './ticketCode'

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateAccessToken(random: RandomBytes = cryptoRandomBytes): string {
  return base64url(random(32))
}

export function isAccessToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

export async function hashAccessToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
