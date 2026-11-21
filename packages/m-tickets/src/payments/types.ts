/**
 * The payment-provider seam. Everything outside src/payments/<provider>/ talks
 * to payments through these types only; importing a provider SDK anywhere else
 * fails lint (eslint.config.js, no-restricted-imports).
 *
 * Money rule: ticket revenue goes 100% to the client. Providers charge on the
 * client's own account and take no application or platform fee.
 */

export type PaymentProviderId = 'stripe' | 'square'
export type PaymentAccountStatus = 'onboarding' | 'connected' | 'disabled'

export interface TenantPaymentAccount {
  tenantId: string
  provider: PaymentProviderId
  providerAccountId: string
  status: PaymentAccountStatus
}

export interface ConnectAccountRequest {
  tenantId: string
  tenantName: string
  email?: string | null
  /** Resume onboarding for an account created earlier instead of creating another. */
  existingProviderAccountId?: string | null
  /** Where the provider sends the organizer when onboarding finishes. */
  returnUrl: string
  /** Where the provider sends the organizer if the onboarding link expired. */
  refreshUrl: string
}

export interface ConnectAccountResult {
  providerAccountId: string
  /** Send the organizer here to finish onboarding on the provider's site. */
  onboardingUrl: string
  status: PaymentAccountStatus
}

export interface AccountStatusResult {
  status: PaymentAccountStatus
  chargesEnabled: boolean
  detailsSubmitted: boolean
}

export interface CheckoutLine {
  name: string
  quantity: number
  unitAmountCents: number
}

export interface CheckoutOrder {
  orderId: string
  tenantId: string
  eventId: string
  currency: string
  buyerEmail: string
  totalCents: number
  lines: readonly CheckoutLine[]
  /** When the provider session should stop accepting payment. */
  expiresAt: Date
}

export interface CheckoutUrls {
  successUrl: string
  cancelUrl: string
}

export interface CheckoutSession {
  providerSessionId: string
  redirectUrl: string
  expiresAt: Date
}

/** Provider webhooks normalized into what M-Tickets cares about. */
export type WebhookResult =
  | {
      kind: 'checkout_completed'
      orderId: string
      /** Must match the order's provider_checkout_ref; checked before completing. */
      providerSessionId: string
      providerPaymentRef: string
      amountCents: number
      currency: string
      providerAccountId: string | null
    }
  | { kind: 'checkout_expired'; orderId: string }
  | {
      kind: 'payment_refunded'
      providerPaymentRef: string
      amountRefundedCents: number
      fullyRefunded: boolean
      providerAccountId: string | null
    }
  | { kind: 'account_updated'; providerAccountId: string; account: AccountStatusResult }
  | { kind: 'ignored'; eventType: string }

export interface RefundRequest {
  account: TenantPaymentAccount
  providerPaymentRef: string
  /** Omit for a full refund. */
  amountCents?: number
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent'
  /** Retries with the same key never refund twice. */
  idempotencyKey: string
}

export interface RefundResult {
  providerRefundRef: string
  status: 'pending' | 'succeeded' | 'failed'
}

export interface PaymentProvider {
  readonly id: PaymentProviderId
  /** Create (or resume) the client's own provider account and return an onboarding link. */
  connectAccount(request: ConnectAccountRequest): Promise<ConnectAccountResult>
  getAccountStatus(providerAccountId: string): Promise<AccountStatusResult>
  /** Start a hosted checkout on the client's account. Revenue goes to the client in full. */
  createCheckout(order: CheckoutOrder, account: TenantPaymentAccount, urls: CheckoutUrls): Promise<CheckoutSession>
  /** Verify the signature, then normalize. Throws WebhookSignatureError on a bad signature. */
  handleWebhook(rawBody: string, signature: string | null): Promise<WebhookResult>
  refund(request: RefundRequest): Promise<RefundResult>
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly provider: PaymentProviderId,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'PaymentProviderError'
  }
}

export class WebhookSignatureError extends Error {
  constructor(readonly provider: PaymentProviderId) {
    super(`Invalid ${provider} webhook signature`)
    this.name = 'WebhookSignatureError'
  }
}

export class PaymentsNotImplementedError extends Error {
  constructor(provider: PaymentProviderId, method: string) {
    super(`${provider} payments are not implemented yet (${method})`)
    this.name = 'PaymentsNotImplementedError'
  }
}
