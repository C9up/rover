import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Mail,
	type MailMessage,
	type MailSendOutcome,
	type MailTransport,
	registerTransport,
} from "../../src/index.js";
import { RoverError } from "../../src/RoverError.js";
import { defined } from "../__helpers__/defined.js";

type Step = "ok" | Error;

class ScriptedTransport implements MailTransport {
	calls = 0;
	constructor(private behaviour: Step[]) {}
	async send(_message: MailMessage): Promise<MailSendOutcome> {
		const idx = this.calls;
		this.calls += 1;
		const step =
			this.behaviour[idx] ?? this.behaviour[this.behaviour.length - 1];
		if (step === "ok") return;
		throw step;
	}
}

const providerError = (status: number): RoverError =>
	new RoverError("E_MAIL_PROVIDER_ERROR", `provider returned ${status}`, {
		context: {
			provider: "test",
			upstreamStatus: String(status),
			providerMessage: "mocked",
		},
	});

const errnoError = (code: string): Error => {
	const err = new Error(`network: ${code}`);
	(err as { code?: string }).code = code;
	return err;
};

const makeMail = (
	transportName: string,
	transport: MailTransport,
	opts: {
		retry?: {
			maxAttempts?: number;
			baseDelayMs?: number;
			factor?: number;
			maxDelayMs?: number;
		};
		transportRetry?: {
			maxAttempts?: number;
			baseDelayMs?: number;
			factor?: number;
			maxDelayMs?: number;
		};
		hooks?: {
			onSent?: (event: unknown) => void;
			onFailed?: (event: unknown) => void;
		};
	} = {},
): Mail => {
	registerTransport(transportName, () => transport);
	return new Mail(
		{
			default: "log",
			from: "default@example.com",
			transports: {
				log: {
					transport: transportName,
					...(opts.transportRetry
						? {
								retry: {
									maxAttempts: opts.transportRetry.maxAttempts ?? 3,
									baseDelayMs: opts.transportRetry.baseDelayMs ?? 500,
									factor: opts.transportRetry.factor ?? 2,
									maxDelayMs: opts.transportRetry.maxDelayMs,
								},
							}
						: {}),
				},
			},
			retry: opts.retry
				? {
						maxAttempts: opts.retry.maxAttempts ?? 3,
						baseDelayMs: opts.retry.baseDelayMs ?? 500,
						factor: opts.retry.factor ?? 2,
						maxDelayMs: opts.retry.maxDelayMs,
					}
				: undefined,
		},
		{ hooks: opts.hooks },
	);
};

describe("rover > retry", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("transient recovery: 502 twice, then ok → resolves; transport called 3 times", async () => {
		const transport = new ScriptedTransport([
			providerError(502),
			providerError(502),
			"ok",
		]);
		const mail = makeMail("tail-retry-1", transport, {
			retry: { baseDelayMs: 10, factor: 1, maxAttempts: 3 },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).resolves.toBeUndefined();
		expect(transport.calls).toBe(3);
	});

	it("permanent failure: 400 → rejects immediately; transport called once", async () => {
		const transport = new ScriptedTransport([providerError(400)]);
		const mail = makeMail("tail-retry-2", transport, {
			retry: { baseDelayMs: 10, factor: 1, maxAttempts: 3 },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
			context: { upstreamStatus: "400" },
		});
		expect(transport.calls).toBe(1);
	});

	it("exhausted retries: always 503 → rejects with LAST error and attempts annotation", async () => {
		const transport = new ScriptedTransport([
			providerError(503),
			providerError(503),
			providerError(503),
		]);
		const mail = makeMail("tail-retry-3", transport, {
			retry: { baseDelayMs: 10, factor: 1, maxAttempts: 3 },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
			context: { upstreamStatus: "503", attempts: "3" },
		});
		expect(transport.calls).toBe(3);
	});

	it("rate-limit: 429 is retryable", async () => {
		const transport = new ScriptedTransport([providerError(429), "ok"]);
		const mail = makeMail("tail-retry-4", transport, {
			retry: { baseDelayMs: 10, factor: 1, maxAttempts: 3 },
		});

		await mail.send((m) => m.to("u@x.com").subject("S"));
		expect(transport.calls).toBe(2);
	});

	it("network errno: ECONNRESET is retryable", async () => {
		const transport = new ScriptedTransport([errnoError("ECONNRESET"), "ok"]);
		const mail = makeMail("tail-retry-5", transport, {
			retry: { baseDelayMs: 10, factor: 1, maxAttempts: 3 },
		});

		await mail.send((m) => m.to("u@x.com").subject("S"));
		expect(transport.calls).toBe(2);
	});

	it("per-transport retry override takes precedence over global", async () => {
		const transport = new ScriptedTransport([
			providerError(503),
			providerError(503),
			providerError(503),
			providerError(503),
			"ok",
		]);
		const mail = makeMail("tail-retry-6", transport, {
			retry: { maxAttempts: 3, baseDelayMs: 10, factor: 1 },
			transportRetry: { maxAttempts: 5, baseDelayMs: 10, factor: 1 },
		});

		await mail.send((m) => m.to("u@x.com").subject("S"));
		expect(transport.calls).toBe(5);
	});

	it("exhaustion fires onFailed hook with the last error", async () => {
		const transport = new ScriptedTransport([
			providerError(503),
			providerError(503),
		]);
		const onFailed = vi.fn();
		const onSent = vi.fn();
		const mail = makeMail("tail-retry-7", transport, {
			retry: { maxAttempts: 2, baseDelayMs: 10, factor: 1 },
			hooks: { onSent, onFailed },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).rejects.toBeInstanceOf(RoverError);

		expect(onFailed).toHaveBeenCalledOnce();
		const [event] = defined(onFailed.mock.calls[0]);
		const failure = event as {
			to: string[];
			transportName: string;
			error: { upstreamStatus?: number; attempts: number };
		};
		expect(failure.to).toEqual(["u@x.com"]);
		expect(failure.transportName).toBe("log");
		expect(failure.error.upstreamStatus).toBe(503);
		expect(failure.error.attempts).toBe(2);
		expect(onSent).not.toHaveBeenCalled();
	});

	it("success fires onSent hook with the final message", async () => {
		const transport = new ScriptedTransport(["ok"]);
		const onFailed = vi.fn();
		const onSent = vi.fn();
		const mail = makeMail("tail-retry-8", transport, {
			hooks: { onSent, onFailed },
		});

		await mail.send((m) => m.to("u@x.com").subject("Yo"));

		expect(onSent).toHaveBeenCalledOnce();
		expect(onFailed).not.toHaveBeenCalled();
	});

	it("onSent hook that throws does NOT reject the successful send", async () => {
		const transport = new ScriptedTransport(["ok"]);
		const onSent = vi.fn().mockImplementation(() => {
			throw new Error("logging down");
		});
		const onFailed = vi.fn();
		const mail = makeMail("tail-retry-hook-1", transport, {
			hooks: { onSent, onFailed },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).resolves.toBeUndefined();
		expect(onSent).toHaveBeenCalledOnce();
		expect(onFailed).not.toHaveBeenCalled();
	});

	it("onFailed hook that throws does NOT mask the original transport error", async () => {
		const transport = new ScriptedTransport([providerError(400)]);
		const onFailed = vi.fn().mockImplementation(() => {
			throw new Error("logger down");
		});
		const mail = makeMail("tail-retry-hook-2", transport, {
			retry: { maxAttempts: 2, baseDelayMs: 5, factor: 1 },
			hooks: { onFailed },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).rejects.toMatchObject({
			code: "E_MAIL_PROVIDER_ERROR",
			context: { upstreamStatus: "400" },
		});
		expect(onFailed).toHaveBeenCalledOnce();
	});

	it("provider returning empty-string providerId falls back to generated messageId", async () => {
		class EmptyProviderIdTransport implements MailTransport {
			async send(_m: MailMessage) {
				return { providerId: "" };
			}
		}
		const onSent = vi.fn();
		const mail = makeMail("tail-retry-hook-3", new EmptyProviderIdTransport(), {
			hooks: { onSent },
		});

		await mail.send((m) => m.to("u@x.com").subject("S"));
		const [event] = defined(onSent.mock.calls[0]);
		const sent = event as { messageId: string };
		expect(sent.messageId).toMatch(/^[0-9a-f]{32}$/);
	});

	it("maxAttempts: 0 is rejected at config resolution, not silently throw undefined", async () => {
		const transport = new ScriptedTransport(["ok"]);
		registerTransport("tail-retry-hook-4", () => transport);
		expect(
			() =>
				new Mail({
					default: "log",
					from: "default@example.com",
					transports: { log: { transport: "tail-retry-hook-4" } },
					retry: { maxAttempts: 0, baseDelayMs: 0, factor: 1 },
				}),
		).not.toThrow(); // config stored — validation happens at dispatch
		// Dispatch validates via resolveRetryConfig → throws RoverError
		const mail = new Mail({
			default: "log",
			from: "default@example.com",
			transports: { log: { transport: "tail-retry-hook-4" } },
			retry: { maxAttempts: 0, baseDelayMs: 0, factor: 1 },
		});
		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).rejects.toMatchObject({ code: "E_MAIL_RETRY_CONFIG" });
	});

	it("retries on E_MAIL_PROVIDER_ERROR with networkCode ECONNRESET (no HTTP status)", async () => {
		const { isRetryableError } = await import("../../src/retry.js");
		const err = new RoverError("E_MAIL_PROVIDER_ERROR", "socket hang up", {
			context: {
				provider: "smtp",
				upstreamStatus: "0",
				networkCode: "ECONNRESET",
				providerMessage: "socket hang up",
			},
		});
		expect(isRetryableError(err)).toBe(true);
	});

	it("honours provider Retry-After header in backoff delay", async () => {
		const errWithRetryAfter = new RoverError(
			"E_MAIL_PROVIDER_ERROR",
			"provider throttled",
			{
				context: {
					provider: "test",
					upstreamStatus: "429",
					providerMessage: "rate-limit",
					retryAfter: "2", // seconds
				},
			},
		);
		const { computeBackoffMs } = await import("../../src/retry.js");
		const config = {
			maxAttempts: 3,
			baseDelayMs: 10, // would normally be 10ms
			factor: 1,
			maxDelayMs: 10_000,
		};
		const delay = computeBackoffMs(1, config, errWithRetryAfter);
		// Retry-After was 2 seconds → 2000 ms, overrides the 10ms base delay
		expect(delay).toBe(2000);
	});

	it("exponential backoff: factor 2 produces increasing delays clamped to maxDelayMs", async () => {
		const transport = new ScriptedTransport([
			providerError(503),
			providerError(503),
			providerError(503),
			"ok",
		]);
		registerTransport("tail-retry-backoff-1", () => transport);
		const mail = new Mail(
			{
				default: "log",
				from: "default@example.com",
				transports: { log: { transport: "tail-retry-backoff-1" } },
				retry: {
					maxAttempts: 4,
					baseDelayMs: 100,
					factor: 2,
					maxDelayMs: 300,
				},
			},
			{},
		);

		const start = Date.now();
		await mail.send((m) => m.to("u@x.com").subject("S"));
		const elapsed = Date.now() - start;
		// Expected delays between attempts: 100ms, 200ms, 300ms (clamped).
		// With shouldAdvanceTime, vitest advances real time so elapsed ≈ sum.
		expect(transport.calls).toBe(4);
		expect(elapsed).toBeGreaterThanOrEqual(500);
	});

	it("events carry cc and bcc alongside to", async () => {
		const transport = new ScriptedTransport(["ok"]);
		const onSent = vi.fn();
		const mail = makeMail("tail-retry-event-1", transport, {
			hooks: { onSent },
		});

		await mail.send((m) =>
			m.to("a@x.com").cc("b@x.com").bcc("c@x.com").subject("S").text("x"),
		);

		const sent = defined(onSent.mock.calls[0])[0] as {
			to: string[];
			cc: string[];
			bcc: string[];
		};
		expect(sent.to).toEqual(["a@x.com"]);
		expect(sent.cc).toEqual(["b@x.com"]);
		expect(sent.bcc).toEqual(["c@x.com"]);
	});

	it("annotateAttempts does NOT mutate the original error instance (clone)", async () => {
		const original = providerError(503);
		const transport = new ScriptedTransport([original, original]);
		const mail = makeMail("tail-retry-clone-1", transport, {
			retry: { maxAttempts: 2, baseDelayMs: 5, factor: 1 },
		});

		let caught: RoverError | undefined;
		try {
			await mail.send((m) => m.to("u@x.com").subject("S"));
		} catch (err) {
			caught = err as RoverError;
		}
		expect(caught).toBeDefined();
		expect(caught?.context.attempts).toBe("2");
		// The error passed to the transport on attempt 1 had no attempts annotation;
		// caught error has one. If we'd mutated the shared instance, original would too.
		expect(original.context.attempts).toBeUndefined();
	});

	it("non-retryable error type (plain error) → throws immediately", async () => {
		const transport = new ScriptedTransport([
			new Error("bug in prepare()"),
			"ok",
		]);
		const mail = makeMail("tail-retry-9", transport, {
			retry: { maxAttempts: 3, baseDelayMs: 10, factor: 1 },
		});

		await expect(
			mail.send((m) => m.to("u@x.com").subject("S")),
		).rejects.toThrow("bug in prepare()");
		expect(transport.calls).toBe(1);
	});
});
