import 'server-only'
import { DEFAULT_HOLD_MINUTES } from '@zevaryn/m-tickets/server'
import { z } from 'zod'

// Empty strings in .env files mean "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.url().transform((url) => url.replace(/\/+$/, '')),
})

const serverSchema = z
  .object({
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    TICKETS_QR_SECRET: z.string().min(32, 'TICKETS_QR_SECRET must be at least 32 characters'),
    TICKETS_HOLD_MINUTES: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : Number(value)),
      z.number().int().min(31).max(120).default(DEFAULT_HOLD_MINUTES),
    ),
    STRIPE_SECRET_KEY: optional(z.string().regex(/^(sk|rk)_(test|live)_/, 'Expected a Stripe secret key')),
    STRIPE_CONNECT_WEBHOOK_SECRET: optional(z.string().startsWith('whsec_')),
    STRIPE_CONNECT_ACCOUNT_TYPE: optional(z.enum(['standard', 'express'])),
    TICKETS_DELIVERY_KEY: z.string().min(32, 'TICKETS_DELIVERY_KEY must be at least 32 characters'),
    RESEND_API_KEY: optional(z.string().startsWith('re_', 'Expected a Resend API key (re_...)')),
    TICKETS_EMAIL_FROM: optional(z.email('TICKETS_EMAIL_FROM must be a plain address, e.g. tickets@mail.example.com')),
    TICKETS_EMAIL_REPLY_TO: optional(z.email()),
    CRON_SECRET: optional(z.string().min(32, 'CRON_SECRET must be at least 32 characters')),
  })
  .superRefine((env, ctx) => {
    if (process.env.NODE_ENV !== 'production' && env.STRIPE_SECRET_KEY && /_live_/.test(env.STRIPE_SECRET_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'Live Stripe keys are refused outside production. Use a test key.' })
    }
    if (env.TICKETS_QR_SECRET.startsWith('replace-with')) {
      ctx.addIssue({ code: 'custom', message: 'TICKETS_QR_SECRET is still the placeholder from .env.example' })
    }
    if (env.TICKETS_DELIVERY_KEY.startsWith('replace-with')) {
      ctx.addIssue({ code: 'custom', message: 'TICKETS_DELIVERY_KEY is still the placeholder from .env.example' })
    }
    if (env.TICKETS_DELIVERY_KEY === env.TICKETS_QR_SECRET) {
      ctx.addIssue({ code: 'custom', message: 'TICKETS_DELIVERY_KEY must differ from TICKETS_QR_SECRET' })
    }
    if (Boolean(env.RESEND_API_KEY) !== Boolean(env.TICKETS_EMAIL_FROM)) {
      ctx.addIssue({ code: 'custom', message: 'Set RESEND_API_KEY and TICKETS_EMAIL_FROM together' })
    }
    // In production a missing email provider would silently drop every ticket email.
    if (process.env.NODE_ENV === 'production' && !env.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', message: 'RESEND_API_KEY and TICKETS_EMAIL_FROM are required in production' })
    }
  })

let publicCache: z.output<typeof publicSchema> | undefined
let serverCache: z.output<typeof serverSchema> | undefined

function parse<T extends z.ZodType>(schema: T, label: string): z.output<T> {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid ${label} environment. See apps/web/.env.example.\n${issues}`)
  }
  return result.data
}

/** Read lazily so `next build` works without secrets. */
export function publicEnv() {
  publicCache ??= parse(publicSchema, 'public')
  return publicCache
}

export function serverEnv() {
  serverCache ??= parse(serverSchema, 'server')
  return serverCache
}
