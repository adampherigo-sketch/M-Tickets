import { listPaymentAccounts, type PaymentAccountRecord } from '../db'
import type { PaymentProviderId } from '../payments/types'
import type { TicketsContext } from './context'

/** The tenant's account with one provider, whatever its status. */
export async function tenantPaymentAccount(
  ctx: TicketsContext,
  tenantId: string,
  provider: PaymentProviderId,
): Promise<PaymentAccountRecord | null> {
  return (await listPaymentAccounts(ctx.service, tenantId)).find((a) => a.provider === provider) ?? null
}
