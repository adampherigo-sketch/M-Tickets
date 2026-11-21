/**
 * The buyer's ticket-link token, encrypted so a confirmation sent later (after
 * a paid order completes in a webhook) can still carry the link. Only the
 * token's hash is on the order; this ciphertext lives in ticket_order_delivery
 * until the confirmation is sent, then it is wiped.
 *
 * AES-256-GCM via Web Crypto. The key is SHA-256 of TICKETS_DELIVERY_KEY, and
 * the order's access-token hash is the additional data, so a ciphertext copied
 * onto another order's row will not decrypt.
 *
 * Format: "v1.<iv>.<ciphertext+tag>", both parts base64url.
 */
import { base64url, fromBase64url } from './base64url'

export const MIN_DELIVERY_KEY_LENGTH = 32
const VERSION = 'v1'

async function importKey(secret: string): Promise<CryptoKey> {
  if (secret.length < MIN_DELIVERY_KEY_LENGTH) {
    throw new Error(`TICKETS_DELIVERY_KEY must be at least ${MIN_DELIVERY_KEY_LENGTH} characters`)
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptDeliveryToken(token: string, accessTokenHash: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(accessTokenHash) },
    await importKey(secret),
    new TextEncoder().encode(token),
  )
  return `${VERSION}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`
}

/** The token, or null when the ciphertext is malformed, tampered with, for another order, or under another key. */
export async function decryptDeliveryToken(
  ciphertext: string,
  accessTokenHash: string,
  secret: string,
): Promise<string | null> {
  const [version, ivText, sealedText, extra] = ciphertext.split('.')
  if (version !== VERSION || !ivText || !sealedText || extra !== undefined) return null
  const iv = fromBase64url(ivText)
  const sealed = fromBase64url(sealedText)
  if (!iv || iv.length !== 12 || !sealed) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(accessTokenHash) },
      await importKey(secret),
      sealed,
    )
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}
