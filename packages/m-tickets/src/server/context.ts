import type { EventPublisher } from '@zevaryn/core/events'
import type { DbClient } from '@zevaryn/database'
import type { PaymentProviderRegistry } from '../payments/registry'

export interface TicketsServerConfig {
  /** Absolute origin used to build redirect URLs, e.g. https://app.zevaryn.com */
  appUrl: string
  /** HMAC key for QR payloads. 32+ characters. */
  qrSecret: string
  /**
   * How long an unpaid order holds its seats. Kept a few minutes longer than
   * the provider session so a buyer paying at the last second is never
   * charged for a seat that was already released.
   */
  holdMinutes: number
  /** Provider checkout lifetime. Stripe requires at least 30 minutes. */
  checkoutSessionMinutes: number
  /**
   * Encrypts each order's ticket-link token until its confirmation is sent.
   * 32+ characters. Changing it only costs pending confirmations their
   * original link: they are sent with a fresh one instead.
   */
  deliveryKey: string
  /** True once a text-message sender is registered; the buyer form then offers "Text". */
  smsEnabled: boolean
}

export const DEFAULT_HOLD_MINUTES = 35
export const DEFAULT_CHECKOUT_SESSION_MINUTES = 31

/**
 * What the M-Tickets server layer needs. The app's composition root builds
 * this once (apps/web/src/lib/tickets.ts); tests build it with fakes.
 */
export interface TicketsContext {
  /** Service-role client. Never expose to the browser. */
  service: DbClient
  payments: PaymentProviderRegistry
  publisher: EventPublisher
  config: TicketsServerConfig
  now: () => Date
}
