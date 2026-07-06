import { randomBytes } from "node:crypto";
import type { EmitterLike, MailMessage } from "../Mail.js";
import type { MailDispatcher } from "./MailJob.js";

/**
 * Default in-memory messenger for `sendLater()` when no `@c9up/bay` queue is
 * wired — mirrors `@adonisjs/mail`'s `MemoryQueueMessenger`. The send is
 * scheduled on a microtask so `sendLater()` returns immediately (fire-and-
 * forget). Background delivery failures surface on the `queued:mail:error`
 * event rather than becoming unhandled rejections.
 */
export class MemoryMailMessenger {
	#dispatcher: MailDispatcher;
	#emitter: EmitterLike | null;

	constructor(dispatcher: MailDispatcher, emitter: EmitterLike | null) {
		this.#dispatcher = dispatcher;
		this.#emitter = emitter;
	}

	queue(message: MailMessage, transport?: string): string {
		const jobId = `mem_${randomBytes(12).toString("hex")}`;
		queueMicrotask(() => {
			this.#dispatcher
				.dispatchMessage(message, transport)
				.catch((error: unknown) => {
					if (!this.#emitter) return;
					try {
						this.#emitter.emit("queued:mail:error", {
							jobId,
							transportName: transport,
							error:
								error instanceof Error
									? { message: error.message }
									: { message: String(error) },
						});
					} catch {
						// Event bus failure ≠ mail failure — swallow so the microtask
						// never rejects.
					}
				});
		});
		return jobId;
	}
}
