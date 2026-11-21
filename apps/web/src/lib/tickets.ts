import 'server-only'
import { SupabaseOutboxPublisher } from '@zevaryn/core/events'
import { createStripeProvider, PaymentProviderRegistry, type PaymentProvider } from '@zevaryn/m-tickets/payments'
import {
  DEFAULT_CHECKOUT_SESSION_MINUTES,
  dispatchMessages,
  LoggingEmailSender,
  ResendEmailSender,
  type MessageSenders,
  type TicketsContext,
} from '@zevaryn/m-tickets/server'
import { after } from 'next/server'
import { publicEnv, serverEnv } from './env'
import { serviceClient } from './supabase/clients'

/**
 * Composition root for M-Tickets: the one place that picks concrete
 * providers, the publisher and config. Square is not registered until its
 * adapter exists, so no tenant can be routed to it.
 */
let context: TicketsContext | undefined
let senders: MessageSenders | undefined

/**
 * Email through Resend when configured, otherwise the server log (development
 * only: env.ts refuses production without Resend). No text-message sender
 * yet; registering one here is what turns on the "Text" choice for buyers.
 */
export function ticketsSenders(): MessageSenders {
  if (senders) return senders
  const env = serverEnv()
  senders = {
    email:
      env.RESEND_API_KEY && env.TICKETS_EMAIL_FROM
        ? new ResendEmailSender({
            apiKey: env.RESEND_API_KEY,
            fromAddress: env.TICKETS_EMAIL_FROM,
            ...(env.TICKETS_EMAIL_REPLY_TO ? { replyTo: env.TICKETS_EMAIL_REPLY_TO } : {}),
          })
        : new LoggingEmailSender(),
    sms: null,
  }
  return senders
}

/**
 * Sends queued messages after the response is on its way, so a buyer's
 * confirmation arrives in seconds without slowing their redirect. The cron
 * route picks up anything this misses.
 */
export function dispatchAfterResponse(): void {
  after(async () => {
    try {
      await dispatchMessages(ticketsContext(), ticketsSenders(), { limit: 10 })
    } catch (error) {
      console.error('[m-tickets] background message dispatch failed', error)
    }
  })
}

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
      deliveryKey: env.TICKETS_DELIVERY_KEY,
      smsEnabled: ticketsSenders().sms !== null,
    },
    now: () => new Date(),
  }
  return context
}
