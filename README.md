# @c9up/rover

Mail transport for Ream — SMTP, log, and pluggable transports (Mailgun, SendGrid, SES, Resend), plus class-based mailers (`BaseMail`), async templating (`htmlView`), in-process retry with exponential backoff, and an optional queue path via `@c9up/bay`.

`ream add @c9up/rover` installs it, registers the provider and writes
`config/mail.ts`. The rest of this page assumes that has run.

## Native template engine

Mail templates compile and render in rover's Rust engine. Each platform's engine is its own npm package, which `@c9up/rover` lists as an optional dependency at its exact version:

| Platform | Package |
|---|---|
| Linux x64 (glibc) | `@c9up/rover-linux-x64-gnu` |
| Linux arm64 (glibc) | `@c9up/rover-linux-arm64-gnu` |
| macOS x64 | `@c9up/rover-darwin-x64` |
| macOS arm64 | `@c9up/rover-darwin-arm64` |
| Windows x64 | `@c9up/rover-win32-x64-msvc` |

Your package manager installs only the one that matches the machine (`os`, `cpu` and `libc` fields), so an install downloads one binary and needs no Rust toolchain. An install run with optional dependencies omitted (`--no-optional`, `--omit=optional`) skips it.

If the engine is missing, rendering a template throws `E_MAIL_TEMPLATE_NAPI_REQUIRED`. Its message and its `help` name the package to install (for example `install @c9up/rover-linux-x64-gnu at the exact version of @c9up/rover: ...`); the load error itself is the exception's `cause`.

In a checkout of this repository, `pnpm build:napi` builds `index.<platform>.node` at the package root, and rover loads that file before looking for the platform package. `node scripts/platform-packages.mjs` rewrites the platform packages' manifests (`npm/<platform>/package.json`) and the optional dependencies after a version bump; CI fails when they are stale.

## Quick start

```ts
import { Mail } from '@c9up/rover'
import '@c9up/rover/transports/mailgun' // opt-in side-effect registration
import env from '#start/env'

const mail = new Mail({
  default: 'mailgun',
  from: 'noreply@acme.com',
  mailers: {
    mailgun: { transport: 'mailgun', apiKey: env.get('MAILGUN_KEY'), domain: 'mg.acme.com' },
  },
})

await mail.send((m) => m.to('user@example.com').subject('Welcome').html('<p>Hi</p>'))
```

Every secret on this page is read through `env.get()` and declared in
`start/env.ts`, so a missing key stops the boot instead of reaching a mailer
or a webhook handler as `undefined`:

```ts
// start/env.ts
import { Env } from '@c9up/ream'

export default await Env.create(new URL('../', import.meta.url), {
  MAILGUN_KEY: Env.schema.string(),
  MAILGUN_SIGNING_KEY: Env.schema.string(),
  SENDGRID_WEBHOOK_PUBLIC_KEY: Env.schema.string(),
  RESEND_WEBHOOK_SECRET: Env.schema.string(),
})
```

## Webhooks

Providers push delivery events (`delivered`, `bounced`, `failed`) to a URL you configure. Rover ships signature-verifying middleware for Mailgun, SendGrid, and Resend that emit canonical `mail.*` events into your event bus.

```ts
import { createMailgunWebhookHandler } from '@c9up/rover/webhooks/mailgun'
import { Emitter } from '@c9up/ream/events'
import env from '#start/env'

const emitter = await app.container.resolve(Emitter)

router.post(
  '/webhooks/mailgun',
  createMailgunWebhookHandler({
    signingKey: env.get('MAILGUN_SIGNING_KEY'),
    emitter,
    // maxAgeSeconds: 300 (default) — rejects replayed-old signatures
    // tokenStore: a shared store when several instances receive webhooks
  }),
)
```

The handler verifies the HMAC over `timestamp + token`, enforces a ±5 minute replay window, and emits `mail.delivered` / `mail.bounced` / `mail.failed` on the bus. Invalid / stale / missing signatures return `401` without leaking internals.

Mailgun's signature does not cover the event data, so each token is accepted once: a captured signature reused with another body gets `401 replayed_signature`. The default `MemoryWebhookTokenStore` lives in the process; behind several instances, pass a shared `tokenStore` whose `claim(token, ttlSeconds)` is atomic (Redis `SET token 1 NX EX ttl`).

SendGrid (ECDSA on P-256 over SHA-256, via `x-twilio-email-event-webhook-signature`) and Resend (Svix HMAC via `svix-signature`) use the same API shape:

```ts
import { createSendGridWebhookHandler } from '@c9up/rover/webhooks/sendgrid'
import { createResendWebhookHandler } from '@c9up/rover/webhooks/resend'

router.post('/webhooks/sendgrid', createSendGridWebhookHandler({
  publicKey: env.get('SENDGRID_WEBHOOK_PUBLIC_KEY'),
  emitter,
}))

router.post('/webhooks/resend', createResendWebhookHandler({
  secret: env.get('RESEND_WEBHOOK_SECRET'), // accepts both `whsec_...` and raw base64
  emitter,
}))
```

The SendGrid `publicKey` is the verification key the dashboard shows for the signed event webhook: an ECDSA key on P-256, in base64 DER or PEM. Any other key is refused when the handler is created (`E_ROVER_WEBHOOK_INVALID_KEY`).

### The signed bytes

Each handler is a Ream route handler: mount it as shown, with or without the body parser in front. It verifies the signature over `ctx.request.rawBuffer()`, the body exactly as it came over the wire, which the body parser leaves untouched. Outside Ream, pass a context with `request.header(name)`, `request.rawBuffer()` returning those wire bytes (never a re-serialised copy: a byte off and every signature fails) and `response.status(code).json(data)`.

## Queue / `sendLater`

Register `@c9up/bay`'s `QueueManager` in your container and Rover will pick it up automatically:

```ts
import '@c9up/rover/transports/mailgun'
import { QueueManager, MemoryDriver } from '@c9up/bay'

app.container.singleton('QueueManager', () => new QueueManager(new MemoryDriver()))

// Then in a request handler:
await mail.sendLater((m) => m.to('user@acme.com').subject('Welcome').html('<p>Hi</p>'))
// returns a job id string; the actual send runs on the Bay worker.
```

Without a `QueueManager` wired, `sendLater` falls back to an in-memory
messenger (immediate microtask dispatch). It never throws for a missing queue.

## Testing

```ts
import '@c9up/rover/transports/mailgun' // register whatever transports your app uses

const fake = mail.fake()
await userRegistration({ email: 'user@acme.com' })
fake.assertSent({ to: 'user@acme.com', subject: 'Welcome' })
mail.restore()
```
