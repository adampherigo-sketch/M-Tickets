/**
 * Ticket codes: what a door volunteer types when a QR code will not scan.
 *
 * 10 characters of Crockford base32 (digits plus letters without I, L, O, U),
 * shown as two groups of five: "7K3QD-W9XPA". 32^10 ≈ 1.1e15 combinations, so a
 * guessed code is vanishingly unlikely to hit a real ticket, and every attempt
 * is logged. Codes are globally unique; the database enforces it with a unique
 * index and the order flow retries on the (astronomically rare) collision.
 */

export const TICKET_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const TICKET_CODE_LENGTH = 10
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/

export type RandomBytes = (length: number) => Uint8Array

export const cryptoRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length))

/** 32 divides 256, so `byte & 31` picks every character with equal probability. */
export function generateTicketCode(random: RandomBytes = cryptoRandomBytes): string {
  const bytes = random(TICKET_CODE_LENGTH)
  if (bytes.length < TICKET_CODE_LENGTH) throw new Error('Random source returned too few bytes')
  let code = ''
  for (let i = 0; i < TICKET_CODE_LENGTH; i += 1) {
    code += TICKET_CODE_ALPHABET.charAt(bytes[i]! & 31)
  }
  return code
}

/**
 * Generates `count` codes that are unique within the batch and not rejected by
 * `isTaken` (for example, codes from a previous attempt that collided).
 */
export function generateUniqueTicketCodes(
  count: number,
  options: { isTaken?: (code: string) => boolean; random?: RandomBytes; maxAttempts?: number } = {},
): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer')
  const { isTaken = () => false, random = cryptoRandomBytes, maxAttempts = count * 10 + 10 } = options
  const codes = new Set<string>()
  let attempts = 0
  while (codes.size < count) {
    attempts += 1
    if (attempts > maxAttempts) throw new Error('Could not generate enough unique ticket codes')
    const code = generateTicketCode(random)
    if (!codes.has(code) && !isTaken(code)) codes.add(code)
  }
  return [...codes]
}

export function isTicketCode(value: string): boolean {
  return CODE_PATTERN.test(value)
}

/**
 * Turns what someone typed into a canonical code, or null. Forgiving the way
 * Crockford base32 intends: case-insensitive, ignores spaces and dashes, and
 * reads O as 0 and I or L as 1.
 */
export function normalizeTicketCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return isTicketCode(cleaned) ? cleaned : null
}

/** "7K3QDW9XPA" -> "7K3QD-W9XPA" */
export function formatTicketCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`
}
