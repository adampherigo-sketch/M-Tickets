/**
 * tenant_payment_accounts. Reads work with a signed-in owner/admin client.
 * Writes need the service role: only the server, after talking to the
 * provider, may record which payout account a tenant uses.
 */
import type { DbClient, Tables } from '@zevaryn/database'
import type { AccountStatusResult, PaymentProviderId, TenantPaymentAccount } from '../payments/types'
import { toTicketsDbError, unwrap } from './errors'

export interface PaymentAccountRecord extends TenantPaymentAccount {
  chargesEnabled: boolean
  detailsSubmitted: boolean
  updatedAt: Date
}

function toRecord(row: Tables<'tenant_payment_accounts'>): PaymentAccountRecord {
  return {
    tenantId: row.tenant_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    status: row.status,
    chargesEnabled: row.charges_enabled,
    detailsSubmitted: row.details_submitted,
    updatedAt: new Date(row.updated_at),
  }
}

export async function listPaymentAccounts(client: DbClient, tenantId: string): Promise<PaymentAccountRecord[]> {
  return unwrap(
    await client.from('tenant_payment_accounts').select('*').eq('tenant_id', tenantId).order('created_at'),
    'List payment accounts',
  ).map(toRecord)
}

export async function upsertPaymentAccount(
  service: DbClient,
  input: { tenantId: string; provider: PaymentProviderId; providerAccountId: string } & AccountStatusResult,
): Promise<void> {
  const { error } = await service.from('tenant_payment_accounts').upsert(
    {
      tenant_id: input.tenantId,
      provider: input.provider,
      provider_account_id: input.providerAccountId,
      status: input.status,
      charges_enabled: input.chargesEnabled,
      details_submitted: input.detailsSubmitted,
    },
    { onConflict: 'tenant_id,provider' },
  )
  if (error) throw toTicketsDbError(error, 'Save payment account')
}

/** From provider webhooks (e.g. Stripe account.updated). Returns false for unknown accounts. */
export async function updatePaymentAccountStatus(
  service: DbClient,
  provider: PaymentProviderId,
  providerAccountId: string,
  status: AccountStatusResult,
): Promise<boolean> {
  const { data, error } = await service
    .from('tenant_payment_accounts')
    .update({
      status: status.status,
      charges_enabled: status.chargesEnabled,
      details_submitted: status.detailsSubmitted,
    })
    .eq('provider', provider)
    .eq('provider_account_id', providerAccountId)
    .select('id')
  if (error) throw toTicketsDbError(error, 'Update payment account')
  return data.length > 0
}
