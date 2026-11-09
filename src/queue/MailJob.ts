import { Buffer } from "node:buffer";
import { field, isRecord, stringField } from "../guards.js";
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
	): Promise<unknown>;
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
	const message = field(payload, "message");
	if (!isRecord(message)) {
		throw new RoverError(
			"E_MAIL_JOB_MALFORMED",
			"Mail job payload.message is missing or not an object",
			{
				hint: "Payload shape must be { message: MailMessage, transport?: string }.",
			},
		);
	}
	// cc/bcc/headers are optional at the queue boundary: an older producer may
	// have left them out.
	const normalised = {
		...message,
		cc: message.cc ?? [],
		bcc: message.bcc ?? [],
		headers: message.headers ?? {},
	};
	if (!hasMailMessageShape(normalised)) {
		throw new RoverError(
			"E_MAIL_JOB_MALFORMED",
			"Mail job payload.message does not match MailMessage shape",
			{
				hint: "Expected `{ from: Recipient, to: Recipient[], ..., attachments: [] }`.",
			},
		);
	}
	return { message: normalised, transport: stringField(payload, "transport") };
}

/**
 * The outline of a MailMessage. Only the outline: every address and header
 * is checked again, in depth, by the dispatch it is handed to.
 */
function hasMailMessageShape(
	m: Record<string, unknown>,
): m is Record<string, unknown> & MailMessage {
	return (
		(typeof m.from === "string" || isRecord(m.from)) &&
		Array.isArray(m.to) &&
		Array.isArray(m.cc) &&
		Array.isArray(m.bcc) &&
		typeof m.subject === "string" &&
		Array.isArray(m.attachments) &&
		m.attachments.every(isRecord) &&
		isRecord(m.headers)
	);
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
		const data = field(att.content, "data");
		if (field(att.content, "type") === "Buffer" && Array.isArray(data)) {
			return {
				...att,
				content: Buffer.from(data.filter((b) => typeof b === "number")),
			};
		}
		return att;
	});
	return { ...message, attachments };
}
