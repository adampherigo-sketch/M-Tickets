/**
 * Stripe adapter, built on Stripe Connect with DIRECT charges:
 *
 *   - Each client has their own connected Stripe account (tenant_payment_accounts).
 *   - Checkout Sessions are created ON that account (the Stripe-Account header),
 *     so the client is the merchant of record and the money lands in their
 *     balance. No application_fee_amount is ever set: Zevaryn takes 0%.
 *   - Stripe's processing fee is deducted from the client's balance by Stripe,
 *     like any charge on their own account. The buyer pays the listed price.
 *   - Events on connected accounts arrive at a Connect webhook endpoint
 *     (STRIPE_CONNECT_WEBHOOK_SECRET), with event.account set.
 *
 * Account type is configurable (accountType). Default "standard": the client
 * gets the full Stripe dashboard, pays Stripe's fees, and Stripe (not Zevaryn)
 * carries negative-balance liability. See the module README for the trade-off.
 *
 * This file and its siblings are the only place allowed to import "stripe".
 */
import Stripe from 'stripe'
import {
  PaymentProviderError,
  WebhookSignatureError,
  type AccountStatusResult,
  type CheckoutOrder,
  type CheckoutSession,
  type CheckoutUrls,
  type ConnectAccountRequest,
  type ConnectAccountResult,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
  type TenantPaymentAccount,
  type WebhookResult,
} from '../types'

export type StripeConnectAccountType = 'standard' | 'express'

/** The slice of the Stripe SDK this adapter uses; tests pass a fake. */
export type StripeClient = Pick<Stripe, 'accounts' | 'accountLinks' | 'checkout' | 'refunds' | 'webhooks'>

export interface StripeProviderOptions {
  client: StripeClient
  /** Signing secret of the Connect webhook endpoint (whsec_...). */
  connectWebhookSecret: string
  accountType?: StripeConnectAccountType
}

/**
 * Controller properties replace the legacy `type: 'standard' | 'express'`.
 * standard = full dashboard, the account pays Stripe fees, Stripe carries losses.
 * express  = Express dashboard; Stripe then requires the platform to carry
 *            losses and pay fees, which Zevaryn could only recoup by taking a
 *            cut. Available for completeness, not recommended.
 */
function controllerFor(accountType: StripeConnectAccountType): Stripe.AccountCreateParams.Controller {
  return accountType === 'standard'
    ? {
        stripe_dashboard: { type: 'full' },
        fees: { payer: 'account' },
        losses: { payments: 'stripe' },
        requirement_collection: 'stripe',
      }
    : {
        stripe_dashboard: { type: 'express' },
        fees: { payer: 'application' },
        losses: { payments: 'application' },
        requirement_collection: 'stripe',
      }
}

export function accountStatusFromStripe(account: Stripe.Account): AccountStatusResult {
  const chargesEnabled = account.charges_enabled ?? false
  const detailsSubmitted = account.details_submitted ?? false
  let status: AccountStatusResult['status'] = 'onboarding'
  if (chargesEnabled) status = 'connected'
  else if (detailsSubmitted && account.requirements?.disabled_reason) status = 'disabled'
  return { status, chargesEnabled, detailsSubmitted }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

export class StripePaymentProvider implements PaymentProvider {
  readonly id = 'stripe' as const
  private readonly client: StripeClient
  private readonly webhookSecret: string
  private readonly accountType: StripeConnectAccountType

  constructor(options: StripeProviderOptions) {
    this.client = options.client
    this.webhookSecret = options.connectWebhookSecret
    this.accountType = options.accountType ?? 'standard'
  }

  async connectAccount(request: ConnectAccountRequest): Promise<ConnectAccountResult> {
    try {
      const account = request.existingProviderAccountId
        ? await this.client.accounts.retrieve(request.existingProviderAccountId)
        : await this.client.accounts.create(
            {
              controller: controllerFor(this.accountType),
              ...(request.email ? { email: request.email } : {}),
              business_profile: { name: request.tenantName },
              metadata: { tenant_id: request.tenantId, source: 'm-tickets' },
            },
            { idempotencyKey: `connect-account:${request.tenantId}` },
          )
      const link = await this.client.accountLinks.create({
        account: account.id,
        type: 'account_onboarding',
        return_url: request.returnUrl,
        refresh_url: request.refreshUrl,
      })
      return { providerAccountId: account.id, onboardingUrl: link.url, status: accountStatusFromStripe(account).status }
    } catch (error) {
      throw new PaymentProviderError('Could not start Stripe onboarding', 'stripe', error)
    }
  }

  async getAccountStatus(providerAccountId: string): Promise<AccountStatusResult> {
    try {
      return accountStatusFromStripe(await this.client.accounts.retrieve(providerAccountId))
    } catch (error) {
      throw new PaymentProviderError('Could not read the Stripe account', 'stripe', error)
    }
  }

  async createCheckout(
    order: CheckoutOrder,
    account: TenantPaymentAccount,
    urls: CheckoutUrls,
  ): Promise<CheckoutSession> {
    if (account.provider !== 'stripe') throw new PaymentProviderError('Not a Stripe account', 'stripe')
    if (account.status !== 'connected')
      throw new PaymentProviderError('Stripe account is not ready to take payments', 'stripe')

    const metadata = {
      order_id: order.orderId,
      tenant_id: order.tenantId,
      event_id: order.eventId,
      source: 'm-tickets',
    }
    try {
      const session = await this.client.checkout.sessions.create(
        {
          mode: 'payment',
          customer_email: order.buyerEmail,
          client_reference_id: order.orderId,
          line_items: order.lines.map((line) => ({
            quantity: line.quantity,
            price_data: {
              currency: order.currency.toLowerCase(),
              unit_amount: line.unitAmountCents,
              product_data: { name: line.name },
            },
          })),
          success_url: urls.successUrl,
          cancel_url: urls.cancelUrl,
          expires_at: Math.floor(order.expiresAt.getTime() / 1000),
          metadata,
          // Deliberately no application_fee_amount: ticket revenue is 100% the client's.
          payment_intent_data: { metadata },
        },
        { stripeAccount: account.providerAccountId, idempotencyKey: `checkout:${order.orderId}` },
      )
      if (!session.url) throw new Error('Stripe returned a session without a URL')
      return {
        providerSessionId: session.id,
        redirectUrl: session.url,
        expiresAt: new Date(session.expires_at * 1000),
      }
    } catch (error) {
      throw new PaymentProviderError('Could not start Stripe checkout', 'stripe', error)
    }
  }

  async handleWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> {
    if (!signature) throw new WebhookSignatureError('stripe')
    let event: Stripe.Event
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    } catch {
      throw new WebhookSignatureError('stripe')
    }
    return normalizeStripeEvent(event)
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    if (request.account.provider !== 'stripe') throw new PaymentProviderError('Not a Stripe account', 'stripe')
    try {
      const refund = await this.client.refunds.create(
        {
          payment_intent: request.providerPaymentRef,
          ...(request.amountCents !== undefined ? { amount: request.amountCents } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
          metadata: { source: 'm-tickets' },
        },
        { stripeAccount: request.account.providerAccountId, idempotencyKey: request.idempotencyKey },
      )
      const status = refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' ? 'failed' : 'pending'
      return { providerRefundRef: refund.id, status }
    } catch (error) {
      throw new PaymentProviderError('Could not refund through Stripe', 'stripe', error)
    }
  }
}

/** Exported for tests: maps a verified Stripe event to a WebhookResult. */
export function normalizeStripeEvent(event: Stripe.Event): WebhookResult {
  const accountId = event.account ?? null
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object
      const orderId = session.metadata?.order_id ?? session.client_reference_id
      const paymentRef = idOf(session.payment_intent)
      // Delayed methods complete the session unpaid; async_payment_succeeded follows.
      if (session.payment_status !== 'paid' || !orderId || !paymentRef)
        return { kind: 'ignored', eventType: event.type }
      return {
        kind: 'checkout_completed',
        orderId,
        providerSessionId: session.id,
        providerPaymentRef: paymentRef,
        amountCents: session.amount_total ?? 0,
        currency: (session.currency ?? '').toUpperCase(),
        providerAccountId: accountId,
      }
    }
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object
      const orderId = session.metadata?.order_id ?? session.client_reference_id
      return orderId ? { kind: 'checkout_expired', orderId } : { kind: 'ignored', eventType: event.type }
    }
    case 'charge.refunded': {
      const charge = event.data.object
      const paymentRef = idOf(charge.payment_intent)
      if (!paymentRef) return { kind: 'ignored', eventType: event.type }
      return {
        kind: 'payment_refunded',
        providerPaymentRef: paymentRef,
        amountRefundedCents: charge.amount_refunded,
        fullyRefunded: charge.refunded,
        providerAccountId: accountId,
      }
    }
    case 'account.updated': {
      const account = event.data.object
      return { kind: 'account_updated', providerAccountId: account.id, account: accountStatusFromStripe(account) }
    }
    default:
      return { kind: 'ignored', eventType: event.type }
  }
}

export function createStripeProvider(options: {
  secretKey: string
  connectWebhookSecret: string
  accountType?: StripeConnectAccountType
}): StripePaymentProvider {
  return new StripePaymentProvider({
    client: new Stripe(options.secretKey, { appInfo: { name: 'M-Tickets by Zevaryn Systems' } }),
    connectWebhookSecret: options.connectWebhookSecret,
    ...(options.accountType ? { accountType: options.accountType } : {}),
  })
}
