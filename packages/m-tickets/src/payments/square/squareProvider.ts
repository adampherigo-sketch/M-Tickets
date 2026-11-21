/**
 * Square adapter: planned, not built. Some clients already take payments with
 * Square; when this lands it must follow the same money rule as Stripe
 * (charge on the client's own Square account, no app fee) and normalize its
 * webhooks into the same WebhookResult.
 */
import {
  PaymentsNotImplementedError,
  type AccountStatusResult,
  type CheckoutSession,
  type ConnectAccountResult,
  type PaymentProvider,
  type RefundResult,
  type WebhookResult,
} from '../types'

export class SquarePaymentProvider implements PaymentProvider {
  readonly id = 'square' as const

  async connectAccount(): Promise<ConnectAccountResult> {
    throw new PaymentsNotImplementedError('square', 'connectAccount')
  }

  async getAccountStatus(): Promise<AccountStatusResult> {
    throw new PaymentsNotImplementedError('square', 'getAccountStatus')
  }

  async createCheckout(): Promise<CheckoutSession> {
    throw new PaymentsNotImplementedError('square', 'createCheckout')
  }

  async handleWebhook(): Promise<WebhookResult> {
    throw new PaymentsNotImplementedError('square', 'handleWebhook')
  }

  async refund(): Promise<RefundResult> {
    throw new PaymentsNotImplementedError('square', 'refund')
  }
}
