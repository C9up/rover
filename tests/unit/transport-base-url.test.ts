/**
 * Every request to a transport's `baseUrl` carries the provider's API key, so
 * the URL is checked before the transport exists.
 */

import type { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { E_INVALID_CONFIG } from "../../src/errors.js";
import { BrevoTransport } from "../../src/transports/BrevoTransport.js";
import { apiBaseUrl } from "../../src/transports/baseUrl.js";
import { MailgunTransport } from "../../src/transports/MailgunTransport.js";
import { SendGridTransport } from "../../src/transports/SendGridTransport.js";
import { SparkPostTransport } from "../../src/transports/SparkPostTransport.js";

const FALLBACK = "https://api.provider.test";

function refusal(value: string): Exception | undefined {
	try {
		apiBaseUrl("Mailgun", value, FALLBACK);
	} catch (error) {
		if (error instanceof E_INVALID_CONFIG) return error;
		throw error;
	}
	return undefined;
}

describe("transport baseUrl", () => {
	it("keeps an HTTPS proxy, without its trailing slashes", () => {
		expect(
			apiBaseUrl("Mailgun", "https://proxy.acme.test/mail///", FALLBACK),
		).toBe("https://proxy.acme.test/mail");
	});

	it("falls back to the provider's endpoint when empty", () => {
		expect(apiBaseUrl("Mailgun", "", FALLBACK)).toBe(FALLBACK);
	});

	it("allows plain HTTP to a loopback host only — a local mock", () => {
		expect(apiBaseUrl("Mailgun", "http://localhost:8025", FALLBACK)).toBe(
			"http://localhost:8025",
		);
		expect(apiBaseUrl("Mailgun", "http://127.0.0.1:9000/", FALLBACK)).toBe(
			"http://127.0.0.1:9000",
		);
		expect(refusal("http://api.mailgun.net")?.message).toMatch(/must be https/);
	});

	it("refuses what would leak the key or reshape the request", () => {
		for (const value of [
			"not a url",
			"ftp://files.acme.test",
			"https://user:pass@proxy.acme.test",
			"https://proxy.acme.test/?token=x",
			"https://proxy.acme.test/#x",
		]) {
			const error = refusal(value);
			expect(error?.code).toBe("E_INVALID_CONFIG");
		}
	});

	it("is checked by every transport that takes one, at construction", () => {
		const config = {
			apiKey: "k",
			key: "k",
			domain: "mg.acme.test",
			baseUrl: "http://attacker.test",
		};
		for (const make of [
			() => new MailgunTransport(config),
			() => new BrevoTransport(config),
			() => new SendGridTransport(config),
			() => new SparkPostTransport(config),
		]) {
			expect(make).toThrowError(/must be https/);
		}
	});
});
