/**
 * Structural HTTP context used by the webhook handlers. Mirrors the
 * `SignedRouteHttpContext` pattern from `@c9up/archive/signed-route`
 * so tests can build plain-object mocks without framework coupling.
 */

export interface WebhookResponse {
	status(code: number): WebhookResponse;
	header(name: string, value: string): WebhookResponse;
	json(data: unknown): void;
}

export interface WebhookHttpContext {
	request: {
		/**
		 * Header lookup. Adapters MUST be case-insensitive per RFC 7230.
		 * Providers send headers like `Svix-Id` or `X-Twilio-...` and the
		 * handler expects to read them via any case.
		 */
		header(name: string): string | undefined;
		/**
		 * Return the exact bytes the provider signed. This MUST be the
		 * raw request body before any parsing / re-serialisation — byte-
		 * for-byte stability is required for Ed25519 / HMAC verification.
		 * Frameworks that buffer must ensure the returned buffer is the
		 * original wire bytes, not a re-encoded copy.
		 */
		rawBody(): Promise<Buffer> | Buffer;
		json?(): unknown;
	};
	response: WebhookResponse;
}

export type WebhookMiddleware = (
	ctx: WebhookHttpContext,
	next: () => Promise<void>,
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
