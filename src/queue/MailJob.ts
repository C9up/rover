import { Buffer } from "node:buffer";
import type { MailAttachment, MailMessage } from "../Mail.js";
import { RoverError } from "../RoverError.js";

export const MAIL_JOB_NAME = "mail.send";

export interface MailJobPayload {
	message: MailMessage;
	transport?: string;
}

/**
 * Minimal structural interface for Bay's `QueueManager` — peer-dep friendly,
 * matches `@c9up/bay`'s public API so `new QueueManager(driver)` is assignable.
 */
export interface BayQueueLike {
	register(name: string, handler: BayJobHandlerLike): void;
	dispatch(
		name: string,
		payload: unknown,
		options?: { maxAttempts?: number },
	): Promise<string>;
}

export interface BayJobHandlerLike {
	handle(payload: unknown): Promise<void>;
}

/** Pared-down RetryConfig shape — avoids importing from `../retry.js` into queue/. */
interface RetryOverride {
	maxAttempts: number;
	baseDelayMs: number;
	factor: number;
	maxDelayMs?: number;
}

export interface MailDispatcher {
	dispatchMessage(
		message: MailMessage,
		transport?: string,
		overrideRetry?: RetryOverride,
	): Promise<void>;
}

/**
 * Bay job handler for queued mail. Sets `maxAttempts: 1` so the in-process
 * retry loop runs exactly once per job execution — Bay's own `maxAttempts`
 * handles re-dispatch on throw. Prevents sync × queue retry compounding.
 */
export class MailJobHandler implements BayJobHandlerLike {
	#mail: MailDispatcher;

	constructor(mail: MailDispatcher) {
		this.#mail = mail;
	}

	async handle(payload: unknown): Promise<void> {
		const parsed = validatePayload(payload);
		// `{ maxAttempts: 1 }` alone is sufficient — the loop runs exactly once
		// and `computeBackoffMs` is never reached; the other RetryConfig fields
		// resolve to defaults via `resolveRetryConfig` but don't affect control
		// flow. Matches AC 8 wording exactly.
		await this.#mail.dispatchMessage(revive(parsed.message), parsed.transport, {
			maxAttempts: 1,
			baseDelayMs: 0,
			factor: 1,
		});
	}
}

/**
 * Narrow an `unknown` payload from the queue driver into a `MailJobPayload`.
 * Throws `E_MAIL_JOB_MALFORMED` when the shape is unrecognisable so Bay records
 * a clean failure rather than crashing inside `dispatchMessage` with a raw
 * `TypeError`.
 */
function validatePayload(payload: unknown): MailJobPayload {
	if (!payload || typeof payload !== "object") {
		throw new RoverError(
			"E_MAIL_JOB_MALFORMED",
			"Mail job payload is missing or not an object",
			{ hint: "Queue driver returned a non-object — check serialisation." },
		);
	}
	const asObj = payload as Record<string, unknown>;
	const message = asObj.message;
	if (!message || typeof message !== "object") {
		throw new RoverError(
			"E_MAIL_JOB_MALFORMED",
			"Mail job payload.message is missing or not an object",
			{
				hint: "Payload shape must be { message: MailMessage, transport?: string }.",
			},
		);
	}
	const m = message as Record<string, unknown>;
	if (
		typeof m.from !== "string" ||
		!Array.isArray(m.to) ||
		!Array.isArray(m.attachments)
	) {
		throw new RoverError(
			"E_MAIL_JOB_MALFORMED",
			"Mail job payload.message does not match MailMessage shape",
			{
				hint: "Expected `{ from: string, to: string[], ..., attachments: [] }`.",
			},
		);
	}
	const transport =
		typeof asObj.transport === "string" ? asObj.transport : undefined;
	return { message: message as MailMessage, transport };
}

/**
 * Revive Buffer attachments after JSON round-trip. Node serialises `Buffer` as
 * `{ type: "Buffer", data: [...bytes] }`; we reconstruct to real `Buffer`.
 */
function revive(message: MailMessage): MailMessage {
	if (!message.attachments || message.attachments.length === 0) return message;
	const attachments: MailAttachment[] = message.attachments.map((att) => {
		if (typeof att.content === "string") return att;
		if (Buffer.isBuffer(att.content)) return att;
		const serialised = att.content as { type?: string; data?: number[] };
		if (serialised?.type === "Buffer" && Array.isArray(serialised.data)) {
			return { ...att, content: Buffer.from(serialised.data) };
		}
		return att;
	});
	return { ...message, attachments };
}
