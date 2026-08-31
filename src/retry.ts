import { RoverError } from "./RoverError.js";

export interface RetryConfig {
	maxAttempts: number;
	baseDelayMs: number;
	factor: number;
	maxDelayMs?: number;
}

export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
	maxAttempts: 3,
	baseDelayMs: 500,
	factor: 2,
	maxDelayMs: 10_000,
};

const RETRYABLE_ERRNO = new Set([
	"ETIMEDOUT",
	"ECONNRESET",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

/**
 * A failure is retryable when:
 *   - it's a `E_MAIL_PROVIDER_ERROR` with `upstreamStatus` 429 or ≥ 500
 *   - or it's a `E_MAIL_PROVIDER_ERROR` whose `context.networkCode` is a known
 *     retryable Node errno (SDK wrappers surface the original errno this way
 *     when the HTTP layer never produced a status)
 *   - or it's a raw Error with a matching Node networking errno on `.code`
 * 4xx (non-429) is treated as permanent: retrying won't help.
 */
export function isRetryableError(err: unknown): boolean {
	if (err instanceof RoverError && err.code === "E_MAIL_PROVIDER_ERROR") {
		const statusStr = err.context.upstreamStatus;
		const status = Number(statusStr);
		if (Number.isFinite(status)) {
			if (status === 429) return true;
			if (status >= 500 && status < 600) return true;
		}
		const networkCode = err.context.networkCode;
		if (networkCode && RETRYABLE_ERRNO.has(networkCode)) return true;
		return false;
	}
	if (err instanceof Error) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && RETRYABLE_ERRNO.has(code)) return true;
		// Node 18+ `fetch` (undici) wraps the underlying socket error in
		// `cause` and surfaces `TypeError: fetch failed` at the top level —
		// the original errno is on `err.cause.code`, not `err.code`. Without
		// this branch transient ECONNRESET/ENOTFOUND/etc. from raw fetch
		// look indistinguishable from a permanent failure and never retry.
		const cause = (err as { cause?: unknown }).cause;
		if (cause && typeof cause === "object") {
			const causeCode = (cause as { code?: unknown }).code;
			if (typeof causeCode === "string" && RETRYABLE_ERRNO.has(causeCode))
				return true;
		}
	}
	return false;
}

export function computeBackoffMs(
	attempt: number,
	config: Required<RetryConfig>,
	err?: unknown,
): number {
	// Honour the provider's Retry-After hint when present (Mailgun/SendGrid/
	// SES/Resend transports capture it into `context.retryAfter`). Value is
	// seconds per HTTP RFC 7231 §7.1.3; we cap at `maxDelayMs` so a malicious
	// or mistaken provider can't force a very-long wait.
	if (err instanceof RoverError && err.code === "E_MAIL_PROVIDER_ERROR") {
		const hint = err.context.retryAfter;
		if (hint) {
			const seconds = Number(hint);
			if (Number.isFinite(seconds) && seconds >= 0) {
				return Math.min(config.maxDelayMs, Math.max(50, seconds * 1000));
			}
		}
	}
	const raw = config.baseDelayMs * config.factor ** (attempt - 1);
	return Math.min(config.maxDelayMs, Math.max(50, raw));
}

export function resolveRetryConfig(
	globalConfig: RetryConfig | undefined,
	transportConfig: RetryConfig | undefined,
): Required<RetryConfig> {
	// Skip entries whose value is `undefined` so a partial override doesn't
	// clobber a default or global value. Pre-spread filter is required because
	// `{ ...obj }` propagates explicit-undefined keys.
	const strip = <T extends object>(x: T | undefined): Partial<T> =>
		x
			? (Object.fromEntries(
					Object.entries(x).filter(([, v]) => v !== undefined),
				) as Partial<T>)
			: {};

	const merged: Required<RetryConfig> = {
		...DEFAULT_RETRY_CONFIG,
		...strip(globalConfig),
		...strip(transportConfig),
	};
	if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) {
		throw new RoverError(
			"E_MAIL_RETRY_CONFIG",
			`RetryConfig.maxAttempts must be an integer >= 1 (got ${merged.maxAttempts})`,
			{ hint: "Set retry.maxAttempts to a positive integer." },
		);
	}
	if (
		typeof merged.baseDelayMs !== "number" ||
		!Number.isFinite(merged.baseDelayMs) ||
		merged.baseDelayMs < 0
	) {
		throw new RoverError(
			"E_MAIL_RETRY_CONFIG",
			`RetryConfig.baseDelayMs must be a non-negative finite number (got ${merged.baseDelayMs})`,
			{ hint: "Use 0 or a positive number; the 50 ms floor kicks in anyway." },
		);
	}
	if (
		typeof merged.factor !== "number" ||
		!Number.isFinite(merged.factor) ||
		merged.factor <= 0
	) {
		throw new RoverError(
			"E_MAIL_RETRY_CONFIG",
			`RetryConfig.factor must be a positive finite number (got ${merged.factor})`,
			{ hint: "Use >= 1 for exponential growth; 1 means constant delay." },
		);
	}
	return merged;
}
