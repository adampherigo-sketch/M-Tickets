import { describe, expect, it } from 'vitest'
import {
  TICKET_CODE_ALPHABET,
  formatTicketCode,
  generateAccessToken,
  generateTicketCode,
  generateUniqueTicketCodes,
  hashAccessToken,
  isAccessToken,
  isTicketCode,
  normalizeTicketCode,
  signQrPayload,
  verifyQrPayload,
  parseCheckInInput,
} from '../../src/domain'

const SECRET = 'test-secret-that-is-at-least-32-characters-long'

describe('ticket codes', () => {
  it('are 10 characters of Crockford base32 with no I, L, O or U', () => {
    for (let i = 0; i < 1000; i += 1) {
      const code = generateTicketCode()
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/)
      expect(isTicketCode(code)).toBe(true)
    }
    expect(TICKET_CODE_ALPHABET).toHaveLength(32)
    expect(TICKET_CODE_ALPHABET).not.toMatch(/[ILOU]/)
  })

  it('maps every byte value onto the alphabet without bias', () => {
    const counts = new Map<string, number>()
    for (let byte = 0; byte < 256; byte += 1) {
      const code = generateTicketCode(() => new Uint8Array(10).fill(byte))
      counts.set(code[0]!, (counts.get(code[0]!) ?? 0) + 1)
    }
    expect(counts.size).toBe(32)
    expect([...counts.values()].every((n) => n === 8)).toBe(true)
  })

  it('does not repeat across a large sample', () => {
    const codes = generateUniqueTicketCodes(50_000)
    expect(new Set(codes).size).toBe(50_000)
  })

  it('retries past collisions within a batch and past taken codes', () => {
    // A source that returns the same bytes twice, then new ones.
    const sequence = [1, 1, 2, 3]
    let call = 0
    const random = () => new Uint8Array(10).fill(sequence[call++]!)
    const taken = new Set([generateTicketCode(() => new Uint8Array(10).fill(2))])
    const codes = generateUniqueTicketCodes(2, { random, isTaken: (c) => taken.has(c) })
    expect(codes).toHaveLength(2)
    expect(new Set(codes).size).toBe(2)
    expect(codes.some((c) => taken.has(c))).toBe(false)
  })

  it('gives up instead of looping forever on a broken random source', () => {
    expect(() => generateUniqueTicketCodes(2, { random: () => new Uint8Array(10) })).toThrow(/enough unique/)
  })

  it('normalizes what people type at the door', () => {
    expect(normalizeTicketCode('7k3qd-w9xpa')).toBe('7K3QDW9XPA')
    expect(normalizeTicketCode(' 7K3QD W9XPA ')).toBe('7K3QDW9XPA')
    expect(normalizeTicketCode('O0IL1-ABCDE')).toBe('00111ABCDE')
    expect(normalizeTicketCode('7K3QD-W9XP')).toBeNull()
    expect(normalizeTicketCode('7K3QD-W9XPU')).toBeNull()
    expect(normalizeTicketCode('')).toBeNull()
  })

  it('formats as two groups of five', () => {
    expect(formatTicketCode('7K3QDW9XPA')).toBe('7K3QD-W9XPA')
  })
})

describe('QR payloads', () => {
  it('round-trips a signed payload and contains no database ids', async () => {
    const payload = await signQrPayload('7K3QDW9XPA', SECRET)
    expect(payload).toMatch(/^MT1\.7K3QDW9XPA\.[A-Za-z0-9_-]{22}$/)
    expect(await verifyQrPayload(payload, SECRET)).toEqual({ ok: true, code: '7K3QDW9XPA' })
  })

  it('rejects a tampered code, a wrong secret and garbage', async () => {
    const payload = await signQrPayload('7K3QDW9XPA', SECRET)
    const tampered = payload.replace('7K3QDW9XPA', '7K3QDW9XPB')
    expect(await verifyQrPayload(tampered, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verifyQrPayload(payload, `${SECRET}-rotated`)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verifyQrPayload('MT1.nope', SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyQrPayload('https://evil.example', SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses a short secret', async () => {
    await expect(signQrPayload('7K3QDW9XPA', 'short')).rejects.toThrow(/32 characters/)
  })

  it('tells scans from typed codes at the door', async () => {
    const payload = await signQrPayload('7K3QDW9XPA', SECRET)
    expect(await parseCheckInInput(payload, SECRET)).toEqual({ ok: true, method: 'qr', code: '7K3QDW9XPA' })
    expect(await parseCheckInInput('7k3qd-w9xpa', SECRET)).toEqual({ ok: true, method: 'manual', code: '7K3QDW9XPA' })
    expect(await parseCheckInInput(payload.slice(0, -2) + 'xx', SECRET)).toEqual({
      ok: false,
      method: 'qr',
      reason: 'invalid_signature',
    })
    expect(await parseCheckInInput('hello', SECRET)).toEqual({ ok: false, method: 'manual', reason: 'invalid_input' })
  })
})

describe('buyer access tokens', () => {
  it('are 256-bit base64url and only their hash is stored', async () => {
    const token = generateAccessToken()
    expect(isAccessToken(token)).toBe(true)
    const hash = await hashAccessToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(token)
    expect(await hashAccessToken(token)).toBe(hash)
  })
})
