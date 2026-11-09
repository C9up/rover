import { field, stringField } from "./guards.js";
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
 * SMTP replies are classified the other way round, see {@link isRetryableSmtp}.
 */
export function isRetryableError(err: unknown): boolean {
	if (err instanceof RoverError && err.code === "E_MAIL_PROVIDER_ERROR") {
		const statusStr = err.context.upstreamStatus;
		const status = Number(statusStr);
		if (err.context.provider === "smtp") return isRetryableSmtp(err, status);
		if (Number.isFinite(status)) {
			if (status === 429) return true;
			if (status >= 500 && status < 600) return true;
		}
		const networkCode = err.context.networkCode;
		if (networkCode && RETRYABLE_ERRNO.has(networkCode)) return true;
		return false;
	}
	if (err instanceof Error) {
		const code = stringField(err, "code");
		if (code !== undefined && RETRYABLE_ERRNO.has(code)) return true;
		// Node 18+ `fetch` (undici) wraps the underlying socket error in
		// `cause` and surfaces `TypeError: fetch failed` at the top level —
		// the original errno is on `err.cause.code`, not `err.code`. Without
		// this branch transient ECONNRESET/ENOTFOUND/etc. from raw fetch
		// look indistinguishable from a permanent failure and never retry.
		const causeCode = stringField(field(err, "cause"), "code");
		if (causeCode !== undefined && RETRYABLE_ERRNO.has(causeCode)) return true;
	}
	return false;
}

/**
 * SMTP reply classes are not HTTP's (RFC 5321 §4.2.1): 4yz is transient and
 * worth repeating (greylisting, rate limits), 5yz is permanent and MUST NOT be
 * repeated, so a hard bounce is not hammered. A rejected login is never
 * retried whatever its code: repeating it only helps lock the account.
 */
function isRetryableSmtp(err: RoverError, status: number): boolean {
	const code = err.context.networkCode;
	if (code === "EAUTH") return false;
	if (Number.isFinite(status) && status >= 400 && status < 500) return true;
	if (Number.isFinite(status) && status >= 500) return false;
	return code !== undefined && RETRYABLE_ERRNO.has(code);
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

/**
 * Global and per-transport overrides, merged over the defaults.
 *
 * `Partial`, because that is what the function does: it spreads whatever it is
 * given over {@link DEFAULT_RETRY_CONFIG}, so `{ maxAttempts: 1 }` is a
 * complete answer. Declared as the full `RetryConfig`, a config file writing
 * exactly that was a type error for doing the supported thing — and every
 * caller had to spell `baseDelayMs` and `factor` it did not want to change.
 */
export function resolveRetryConfig(
	globalConfig: Partial<RetryConfig> | undefined,
	transportConfig: Partial<RetryConfig> | undefined,
): Required<RetryConfig> {
	// Per field, the most specific value that is set wins; an explicit
	// `undefined` does not clobber a default or global value.
	const pick = <K extends keyof RetryConfig>(key: K) =>
		transportConfig?.[key] ?? globalConfig?.[key] ?? DEFAULT_RETRY_CONFIG[key];
	const merged: Required<RetryConfig> = {
		maxAttempts: pick("maxAttempts"),
		baseDelayMs: pick("baseDelayMs"),
		factor: pick("factor"),
		maxDelayMs: pick("maxDelayMs"),
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
