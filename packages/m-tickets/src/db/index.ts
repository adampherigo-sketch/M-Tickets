/**
 * Repository layer: the only code that knows table and function names.
 *
 * Which client to pass:
 *   storefront.ts                 anon (or any) client
 *   events.ts, attendees.ts       the signed-in user's client (RLS applies)
 *   paymentAccounts.ts reads      the signed-in user's client
 *   orders.ts, account writes     service-role client, server only
 *   messages.ts                   service-role client, server only
 */
export * from './errors'
export * from './storefront'
export * from './events'
export * from './attendees'
export * from './orders'
export * from './paymentAccounts'
export * from './messages'
