import { describe, expect, it, vi } from 'vitest'
import {
  PaymentProviderRegistry,
  PaymentsNotImplementedError,
  SquarePaymentProvider,
  StripePaymentProvider,
  WebhookSignatureError,
  normalizeStripeEvent,
  selectCheckoutAccount,
  type StripeClient,
  type TenantPaymentAccount,
} from '../../src/payments'

const account: TenantPaymentAccount = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  provider: 'stripe',
  providerAccountId: 'acct_client123',
  status: 'connected',
}

function fakeStripe() {
  const sessionsCreate = vi.fn().mockResolvedValue({
    id: 'cs_test_1',
    url: 'https://checkout.stripe.test/cs_test_1',
    expires_at: 1_900_000_000,
  })
  const accountsCreate = vi.fn().mockResolvedValue({ id: 'acct_new', charges_enabled: false, details_submitted: false })
  const linksCreate = vi.fn().mockResolvedValue({ url: 'https://connect.stripe.test/onboard' })
  const refundsCreate = vi.fn().mockResolvedValue({ id: 're_1', status: 'succeeded' })
  const constructEvent = vi.fn()
  const client = {
    checkout: { sessions: { create: sessionsCreate } },
    accounts: { create: accountsCreate, retrieve: vi.fn() },
    accountLinks: { create: linksCreate },
    refunds: { create: refundsCreate },
    webhooks: { constructEvent },
  } as unknown as StripeClient
  return { client, sessionsCreate, accountsCreate, linksCreate, refundsCreate, constructEvent }
}

const order = {
  orderId: '00000000-0000-4000-8000-0000000000aa',
  tenantId: account.tenantId,
  eventId: '00000000-0000-4000-8000-0000000000bb',
  currency: 'USD',
  buyerEmail: 'buyer@example.com',
  totalCents: 5000,
  lines: [{ name: 'Gala: VIP', quantity: 2, unitAmountCents: 2500 }],
  expiresAt: new Date('2030-01-01T00:00:00Z'),
}

describe('Stripe adapter', () => {
  it('charges on the client account with no application fee', async () => {
    const stripe = fakeStripe()
    const provider = new StripePaymentProvider({ client: stripe.client, connectWebhookSecret: 'whsec_test' })
    const session = await provider.createCheckout(order, account, { successUrl: 'https://s', cancelUrl: 'https://c' })

    expect(session.redirectUrl).toBe('https://checkout.stripe.test/cs_test_1')
    const [params, options] = stripe.sessionsCreate.mock.calls[0]!
    expect(options).toMatchObject({ stripeAccount: 'acct_client123' })
    // The 0% rule: no fee in any form.
    expect(JSON.stringify(params)).not.toMatch(/application_fee/)
    expect(params.payment_intent_data).not.toHaveProperty('application_fee_amount')
    expect(params.payment_intent_data).not.toHaveProperty('transfer_data')
    expect(params.line_items[0]).toMatchObject({ quantity: 2, price_data: { currency: 'usd', unit_amount: 2500 } })
    expect(params.metadata.order_id).toBe(order.orderId)
  })

  it('refuses accounts that are not connected Stripe accounts', async () => {
    const stripe = fakeStripe()
    const provider = new StripePaymentProvider({ client: stripe.client, connectWebhookSecret: 'whsec_test' })
    await expect(
      provider.createCheckout(order, { ...account, status: 'onboarding' }, { successUrl: 's', cancelUrl: 'c' }),
    ).rejects.toThrow(/not ready/)
    expect(stripe.sessionsCreate).not.toHaveBeenCalled()
  })

  it('creates Standard-style accounts by default: client pays Stripe fees, Stripe carries losses', async () => {
    const stripe = fakeStripe()
    const provider = new StripePaymentProvider({ client: stripe.client, connectWebhookSecret: 'whsec_test' })
    const result = await provider.connectAccount({
      tenantId: account.tenantId,
      tenantName: 'Demo Co',
      returnUrl: 'https://r',
      refreshUrl: 'https://f',
    })
    expect(result).toEqual({
      providerAccountId: 'acct_new',
      onboardingUrl: 'https://connect.stripe.test/onboard',
      status: 'onboarding',
    })
    expect(stripe.accountsCreate.mock.calls[0]![0].controller).toEqual({
      stripe_dashboard: { type: 'full' },
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      requirement_collection: 'stripe',
    })
  })

  it('refunds on the client account', async () => {
    const stripe = fakeStripe()
    const provider = new StripePaymentProvider({ client: stripe.client, connectWebhookSecret: 'whsec_test' })
    await provider.refund({ account, providerPaymentRef: 'pi_1', idempotencyKey: 'refund:x' })
    expect(stripe.refundsCreate.mock.calls[0]![1]).toMatchObject({
      stripeAccount: 'acct_client123',
      idempotencyKey: 'refund:x',
    })
  })

  it('rejects webhooks without a valid signature', async () => {
    const stripe = fakeStripe()
    stripe.constructEvent.mockImplementation(() => {
      throw new Error('bad sig')
    })
    const provider = new StripePaymentProvider({ client: stripe.client, connectWebhookSecret: 'whsec_test' })
    await expect(provider.handleWebhook('{}', null)).rejects.toBeInstanceOf(WebhookSignatureError)
    await expect(provider.handleWebhook('{}', 't=1,v1=x')).rejects.toBeInstanceOf(WebhookSignatureError)
  })

  it('normalizes the events M-Tickets cares about', () => {
    const completed = normalizeStripeEvent({
      type: 'checkout.session.completed',
      account: 'acct_client123',
      data: {
        object: {
          id: 'cs_1',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 5000,
          currency: 'usd',
          metadata: { order_id: order.orderId },
          client_reference_id: order.orderId,
        },
      },
    } as never)
    expect(completed).toEqual({
      kind: 'checkout_completed',
      orderId: order.orderId,
      providerSessionId: 'cs_1',
      providerPaymentRef: 'pi_1',
      amountCents: 5000,
      currency: 'USD',
      providerAccountId: 'acct_client123',
    })

    const unpaid = normalizeStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', payment_status: 'unpaid', payment_intent: 'pi_2', metadata: { order_id: 'o' } } },
    } as never)
    expect(unpaid.kind).toBe('ignored')

    expect(
      normalizeStripeEvent({
        type: 'checkout.session.expired',
        data: { object: { metadata: { order_id: 'o1' } } },
      } as never),
    ).toEqual({ kind: 'checkout_expired', orderId: 'o1' })

    expect(
      normalizeStripeEvent({
        type: 'charge.refunded',
        account: 'acct_client123',
        data: { object: { payment_intent: 'pi_1', amount_refunded: 5000, refunded: true } },
      } as never),
    ).toMatchObject({ kind: 'payment_refunded', providerPaymentRef: 'pi_1', fullyRefunded: true })

    expect(
      normalizeStripeEvent({
        type: 'account.updated',
        data: { object: { id: 'acct_client123', charges_enabled: true, details_submitted: true } },
      } as never),
    ).toEqual({
      kind: 'account_updated',
      providerAccountId: 'acct_client123',
      account: { status: 'connected', chargesEnabled: true, detailsSubmitted: true },
    })

    expect(normalizeStripeEvent({ type: 'customer.created', data: { object: {} } } as never)).toEqual({
      kind: 'ignored',
      eventType: 'customer.created',
    })
  })
})

describe('Square stub and provider selection', () => {
  it('Square throws "not implemented" for every method', async () => {
    const square = new SquarePaymentProvider()
    await expect(square.connectAccount()).rejects.toBeInstanceOf(PaymentsNotImplementedError)
    await expect(square.createCheckout()).rejects.toBeInstanceOf(PaymentsNotImplementedError)
    await expect(square.handleWebhook()).rejects.toBeInstanceOf(PaymentsNotImplementedError)
    await expect(square.refund()).rejects.toBeInstanceOf(PaymentsNotImplementedError)
  })

  it('routes checkout to the tenant connected account only', () => {
    expect(selectCheckoutAccount([{ ...account, status: 'onboarding' }])).toBeNull()
    expect(selectCheckoutAccount([{ ...account, provider: 'square', status: 'disabled' }, account])).toBe(account)
  })

  it('reports unconfigured providers clearly', () => {
    const registry = new PaymentProviderRegistry([])
    expect(registry.has('stripe')).toBe(false)
    expect(() => registry.get('stripe')).toThrow(/not configured/)
  })
})
