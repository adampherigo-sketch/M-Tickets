import 'server-only'
import { SupabaseOutboxPublisher } from '@zevaryn/core/events'
import { createStripeProvider, PaymentProviderRegistry, type PaymentProvider } from '@zevaryn/m-tickets/payments'
import { DEFAULT_CHECKOUT_SESSION_MINUTES, type TicketsContext } from '@zevaryn/m-tickets/server'
import { publicEnv, serverEnv } from './env'
import { serviceClient } from './supabase/clients'

/**
 * Composition root for M-Tickets: the one place that picks concrete
 * providers, the publisher and config. Square is not registered until its
 * adapter exists, so no tenant can be routed to it.
 */
let context: TicketsContext | undefined

export function ticketsContext(): TicketsContext {
  if (context) return context
  const env = serverEnv()
  const providers: PaymentProvider[] = []
  if (env.STRIPE_SECRET_KEY && env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    providers.push(
      createStripeProvider({
        secretKey: env.STRIPE_SECRET_KEY,
        connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET,
        accountType: env.STRIPE_CONNECT_ACCOUNT_TYPE ?? 'standard',
      }),
    )
  }
  const service = serviceClient()
  context = {
    service,
    payments: new PaymentProviderRegistry(providers),
    publisher: new SupabaseOutboxPublisher(service),
    config: {
      appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
      qrSecret: env.TICKETS_QR_SECRET,
      holdMinutes: env.TICKETS_HOLD_MINUTES,
      checkoutSessionMinutes: DEFAULT_CHECKOUT_SESSION_MINUTES,
    },
    now: () => new Date(),
  }
  return context
}
