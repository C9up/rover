/**
 * Unit suite for wrapFetchNetworkError — the uniform fetch-rejection
 * wrapper used by the Mailgun / Resend / SendGrid HTTP transports.
 *
 * Covers the three errno-extraction shapes (top-level `.code`,
 * `.cause.code`, neither), `RoverError` pass-through, and message
 * fallback when the rejection carries no `.message`.
 */

import { describe, expect, it } from "vitest";
import { RoverError } from "../../src/RoverError.js";
import { wrapFetchNetworkError } from "../../src/transports/fetchError.js";

describe("rover > wrapFetchNetworkError", () => {
	it("pulls errno from top-level `.code` and surfaces it in `context.networkCode`", () => {
		const err = Object.assign(new TypeError("connect ECONNRESET"), {
			code: "ECONNRESET",
		});
		const wrapped = wrapFetchNetworkError("mailgun", err);
		expect(wrapped).toBeInstanceOf(RoverError);
		expect(wrapped.code).toBe("E_MAIL_PROVIDER_ERROR");
		expect(wrapped.message).toContain("mailgun fetch failed (ECONNRESET)");
		const ctx = wrapped.context as Record<string, string>;
		expect(ctx.provider).toBe("mailgun");
		expect(ctx.networkCode).toBe("ECONNRESET");
		expect(ctx.upstreamStatus).toBe("0");
		expect(ctx.providerMessage).toBe("connect ECONNRESET");
	});

	it("pulls errno from `.cause.code` (undici fetch shape)", () => {
		const err = Object.assign(new TypeError("fetch failed"), {
			cause: { code: "ENOTFOUND" },
		});
		const wrapped = wrapFetchNetworkError("resend", err);
		const ctx = wrapped.context as Record<string, string>;
		expect(ctx.networkCode).toBe("ENOTFOUND");
		expect(wrapped.message).toContain("resend fetch failed (ENOTFOUND)");
	});

	it("omits `networkCode` and the parenthetical when no errno is present", () => {
		const err = new TypeError("something exploded");
		const wrapped = wrapFetchNetworkError("sendgrid", err);
		const ctx = wrapped.context as Record<string, string>;
		expect(ctx.networkCode).toBeUndefined();
		expect(wrapped.message).toBe("sendgrid fetch failed");
		expect(ctx.providerMessage).toBe("something exploded");
	});

	it("falls back to the literal 'fetch failed' when the rejection carries no message", () => {
		const wrapped = wrapFetchNetworkError("mailgun", {});
		const ctx = wrapped.context as Record<string, string>;
		expect(ctx.providerMessage).toBe("fetch failed");
	});

	it("passes a pre-existing RoverError through unchanged", () => {
		const original = new RoverError(
			"E_MAIL_PROVIDER_ERROR",
			"already wrapped",
			{
				context: { provider: "x" },
			},
		);
		const wrapped = wrapFetchNetworkError("ignored", original);
		expect(wrapped).toBe(original);
	});

	it("treats a non-string top-level `code` as absent (no networkCode key)", () => {
		// Some HTTP wrappers set `code: 500` (number) — that's a status, not
		// an errno. The helper must ignore it rather than coerce.
		const err = { code: 500, message: "oops" };
		const wrapped = wrapFetchNetworkError("mailgun", err);
		const ctx = wrapped.context as Record<string, string>;
		expect(ctx.networkCode).toBeUndefined();
		expect(wrapped.message).toBe("mailgun fetch failed");
	});
});
