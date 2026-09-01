/**
 * Emit an event without letting the listener come back.
 *
 * `@adonisjs/events` declares `emit(): Promise<void>` and rethrows when a
 * listener fails and the application registered no error handler. Nothing here
 * awaits an event — a webhook has already been acknowledged, a queued mail has
 * already been sent or already failed — so that rejection had nowhere to go
 * and ended the process over a notification.
 *
 * The emitter is invoked INSIDE the async function rather than before it:
 * `Promise.resolve(emit(...))` runs `emit` first, so a synchronous throw would
 * still escape. The call itself stays synchronous, because an async body runs
 * to its first `await` — only the failure handling is deferred.
 */
export function emitSafely(
	emitter:
		| { emit: (event: string, data: unknown) => unknown }
		| null
		| undefined,
	event: string,
	data: unknown,
): void {
	if (emitter == null) return;
	void (async () => emitter.emit(event, data))().catch((error: unknown) => {
		process.stderr.write(
			`[rover] '${event}' listener failed: ${
				error instanceof Error ? error.message : String(error)
			}\n`,
		);
	});
}
