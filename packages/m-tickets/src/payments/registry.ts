import type { PaymentProvider, PaymentProviderId, TenantPaymentAccount } from './types'

/** Holds the configured providers. A provider missing from config is simply absent. */
export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<PaymentProviderId, PaymentProvider>

  constructor(providers: readonly PaymentProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
  }

  has(id: PaymentProviderId): boolean {
    return this.providers.has(id)
  }

  get(id: PaymentProviderId): PaymentProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new Error(`Payment provider "${id}" is not configured on this server`)
    return provider
  }

  /** Providers an organizer can connect from the payments page. */
  available(): PaymentProviderId[] {
    return [...this.providers.keys()]
  }
}

/**
 * Which account takes a tenant's payments: the connected one, if any. The
 * database allows at most one connected account per tenant.
 */
export function selectCheckoutAccount(accounts: readonly TenantPaymentAccount[]): TenantPaymentAccount | null {
  return accounts.find((account) => account.status === 'connected') ?? null
}
