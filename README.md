# @c9up/rover

Mail transport for Ream — SMTP, log, and pluggable transports (Mailgun, SendGrid, SES, Resend), plus class-based mailers (`BaseMail`), async templating (`htmlView`), in-process retry with exponential backoff, and an optional queue path via `@c9up/bay`.

## Quick start

```ts
import { Mail } from '@c9up/rover'
import '@c9up/rover/transports/mailgun' // opt-in side-effect registration

const mail = new Mail({
  default: 'mailgun',
  from: 'noreply@acme.com',
  transports: {
    mailgun: { transport: 'mailgun', apiKey: process.env.MAILGUN_KEY!, domain: 'mg.acme.com' },
  },
})

await mail.send((m) => m.to('user@example.com').subject('Welcome').html('<p>Hi</p>'))
```

## Webhooks

Providers push delivery events (`delivered`, `bounced`, `failed`) to a URL you configure. Rover ships signature-verifying middleware for Mailgun, SendGrid, and Resend that emit canonical `mail.*` events into your event bus.

```ts
import { createMailgunWebhookHandler } from '@c9up/rover/webhooks/mailgun'
import { Emitter } from '@c9up/ream/events'

const emitter = app.container.resolve(Emitter)

router.post(
  '/webhooks/mailgun',
  createMailgunWebhookHandler({
    signingKey: process.env.MAILGUN_SIGNING_KEY!,
    emitter,
    // maxAgeSeconds: 300 (default) — rejects replayed-old signatures
  }),
)
```

The handler verifies the HMAC over `timestamp + token`, enforces a ±5 minute replay window, and emits `mail.delivered` / `mail.bounced` / `mail.failed` on the bus. Invalid / stale / missing signatures return `401` without leaking internals.

SendGrid (Ed25519 via `x-twilio-email-event-webhook-signature`) and Resend (Svix HMAC via `svix-signature`) use the same API shape:

```ts
import { createSendGridWebhookHandler } from '@c9up/rover/webhooks/sendgrid'
import { createResendWebhookHandler } from '@c9up/rover/webhooks/resend'

router.post('/webhooks/sendgrid', createSendGridWebhookHandler({
  publicKey: process.env.SENDGRID_WEBHOOK_PUBLIC_KEY!,
  emitter,
}))

router.post('/webhooks/resend', createResendWebhookHandler({
  secret: process.env.RESEND_WEBHOOK_SECRET!, // accepts both `whsec_...` and raw base64
  emitter,
}))
```

### `rawBody()` contract

All three handlers rely on `ctx.request.rawBody()` returning the exact bytes the provider signed. If your framework re-parses the body into JSON before the handler sees it and your `rawBody()` returns a re-serialised copy, bytes differ and every signature fails. Mount these handlers on a route where the raw body is preserved (e.g. skip the JSON body parser on `/webhooks/**`).

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
messenger (immediate microtask dispatch) — matching `@adonisjs/mail`'s
`MemoryQueueMessenger`. It never throws for a missing queue.

## Testing

```ts
import '@c9up/rover/transports/mailgun' // register whatever transports your app uses

const fake = mail.fake()
await userRegistration({ email: 'user@acme.com' })
fake.assertSent({ to: 'user@acme.com', subject: 'Welcome' })
mail.restore()
```
