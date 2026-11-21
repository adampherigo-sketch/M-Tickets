/** Money is integer cents everywhere; this is the only place it becomes text. */
export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100)
}

/** "25", "25.5", "25.50" -> 2550. Returns null for anything else. */
export function parseMoneyToCents(input: string): number | null {
  const match = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}
