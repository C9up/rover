/**
 * What the webhook handlers need from the HTTP request, structurally: a Ream
 * `HttpContext` fits as it is, and so does a plain object in a test.
 */

export interface WebhookResponse {
	status(code: number): WebhookResponse;
	json(data: unknown): void;
}

export interface WebhookHttpContext {
	request: {
		/** Header lookup, case-insensitive: providers send `Svix-Id`, `X-Twilio-…`. */
		header(name: string): string | undefined;
		/**
		 * The body exactly as it came over the wire: the bytes the provider
		 * signed. A re-serialised copy differs by a byte and fails every
		 * signature (ECDSA for SendGrid, HMAC for Mailgun and Resend). Ream's
		 * `request.rawBuffer()` is that, with or without the body parser.
		 */
		rawBuffer(): Buffer;
	};
	response: WebhookResponse;
}

/**
 * A webhook handler. Mounted as a Ream route handler (`router.post(path,
 * handler)`), it is called with the context alone; `next` is never called.
 */
export type WebhookMiddleware = (
	ctx: WebhookHttpContext,
	next?: () => Promise<void>,
) => Promise<void>;

export interface WebhookEmitter {
	/**
	 * `unknown`, not `void`. `@adonisjs/events` declares
	 * `emit(): Promise<void>` and rethrows when a listener fails and no error
	 * handler is registered — and a `void` return ACCEPTS a promise-returning
	 * function, so the call site reads as if there were nothing to handle.
	 * Duck-typed, so it stays wider than Adonis's own class: a Node
	 * EventEmitter returns boolean.
	 */
	emit(event: string, data: unknown): unknown;
}
