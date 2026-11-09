/**
 * The SparkPost transport.
 *
 * Like Brevo, it shipped without anything exercising it. SparkPost has one
 * structural quirk the other transports do not: it delivers to a single flat
 * `recipients` list, so cc and bcc are folded in and cc is re-surfaced as a
 * header. Getting that fold wrong either drops a recipient or exposes a bcc.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import type { RoverError } from "../../src/RoverError.js";
import { SparkPostTransport } from "../../src/transports/SparkPostTransport.js";
import { requestInit } from "../__helpers__/defined.js";

const baseMessage = (): MailMessage => ({
	from: "sender@example.com",
	to: ["user@example.com"],
	cc: [],
	bcc: [],
	subject: "Hello",
	html: "<p>Hi</p>",
	text: "Hi",
	attachments: [],
	headers: {},
});

interface SparkPostBody {
	content: { email_rfc822: string };
	recipients: Array<{ address: { email: string } }>;
	return_path?: string;
}

describe("rover > SparkPostTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	const body = (): SparkPostBody =>
		JSON.parse(
			requestInit(fetchSpy.mock.calls, 0).body as string,
		) as SparkPostBody;
	const headers = () =>
		requestInit(fetchSpy.mock.calls, 0).headers as Record<string, string>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ results: { id: "11668787484950529" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("refuses to exist without an API key", () => {
		expect(() => new SparkPostTransport({})).toThrow(/requires apiKey/);
	});

	it("takes the key under either spelling, as a bare Authorization value", async () => {
		await new SparkPostTransport({ key: "k-1" }).send(baseMessage());

		// SparkPost wants the key alone, not `Bearer <key>`.
		expect(headers().Authorization).toBe("k-1");
	});

	it("posts to the transmissions endpoint", async () => {
		await new SparkPostTransport({ apiKey: "k" }).send(baseMessage());

		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.sparkpost.com/api/v1/transmissions",
		);
		expect(headers()["Content-Type"]).toBe("application/json");
	});

	it("takes a base URL, trailing slashes and all", async () => {
		await new SparkPostTransport({
			apiKey: "k",
			baseUrl: "https://proxy.acme.test///",
		}).send(baseMessage());

		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://proxy.acme.test/api/v1/transmissions",
		);
	});

	it("sends nodemailer's MIME as email_rfc822, names encoded in the headers", async () => {
		const message = baseMessage();
		message.from = { address: "app@acme.test", name: "Acme" };
		message.to = [
			{ address: "ada@acme.test", name: "Ada Lovelace" },
			"bare@acme.test",
		];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().recipients).toEqual([
			{ address: { email: "ada@acme.test" } },
			{ address: { email: "bare@acme.test" } },
		]);
		const mime = body().content.email_rfc822;
		expect(mime).toMatch(/^From: Acme <app@acme.test>\r$/m);
		expect(mime).toMatch(
			/^To: Ada Lovelace <ada@acme.test>, bare@acme.test\r$/m,
		);
		expect(mime).toMatch(/^Subject: Hello\r$/m);
	});

	it("delivers to cc and bcc, shows cc, never bcc", async () => {
		const message = baseMessage();
		message.cc = ["cc@acme.test"];
		message.bcc = ["bcc@acme.test"];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().recipients.map((r) => r.address.email)).toEqual([
			"user@example.com",
			"cc@acme.test",
			"bcc@acme.test",
		]);
		const mime = body().content.email_rfc822;
		expect(mime).toMatch(/^Cc: cc@acme.test\r$/m);
		expect(mime).not.toContain("bcc@acme.test");
	});

	it("carries reply-to, headers, html, text and attachments in the MIME", async () => {
		const message = baseMessage();
		message.replyTo = ["reply@acme.test"];
		message.headers = { "X-Tag": ["a", "b"] };
		message.attachments = [
			{ filename: "report.bin", content: Buffer.from([1, 2, 3]) },
		];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		const mime = body().content.email_rfc822;
		expect(mime).toMatch(/^Reply-To: reply@acme.test\r$/m);
		expect(mime).toMatch(/^X-Tag: a\r$/m);
		expect(mime).toContain("<p>Hi</p>");
		expect(mime).toContain("filename=report.bin");
		expect(mime).toContain(Buffer.from([1, 2, 3]).toString("base64"));
	});

	it("refuses a message addressed to nobody at all", async () => {
		const message = baseMessage();
		message.to = [];
		await expect(
			new SparkPostTransport({ apiKey: "k" }).send(message),
		).rejects.toThrow(/no recipients/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends a bcc-only message rather than refusing it", async () => {
		const message = baseMessage();
		message.to = [];
		message.bcc = ["hidden@acme.test"];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().recipients).toEqual([
			{ address: { email: "hidden@acme.test" } },
		]);
	});

	it("lets no line break in the subject open a header", async () => {
		const message = baseMessage();
		message.subject = "Hello\r\nBcc: attacker@evil.test";
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().content.email_rfc822).not.toMatch(/^Bcc:/im);
	});

	it("passes the envelope sender as return_path and the envelope recipients", async () => {
		const message = baseMessage();
		message.envelope = { from: "bounce@acme.test", to: ["env@acme.test"] };
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().return_path).toBe("bounce@acme.test");
		expect(body().recipients).toEqual([
			{ address: { email: "env@acme.test" } },
		]);
	});

	it("hands back the transmission id", async () => {
		const result = await new SparkPostTransport({ apiKey: "k" }).send(
			baseMessage(),
		);
		expect(result?.providerId).toBe("11668787484950529");
	});

	it("falls back to a generated id when the body carries none", async () => {
		fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
		const result = await new SparkPostTransport({ apiKey: "k" }).send(
			baseMessage(),
		);
		expect(result?.providerId).toBeUndefined();
	});

	it("carries the status and the backoff hint on a refusal", async () => {
		fetchSpy.mockResolvedValue(
			new Response("too many transmissions", {
				status: 429,
				headers: { "retry-after": "30" },
			}),
		);

		try {
			await new SparkPostTransport({ apiKey: "k" }).send(baseMessage());
			expect.unreachable("a 429 has to be reported");
		} catch (error) {
			const rover = error as RoverError;
			expect(rover.code).toBe("E_MAIL_PROVIDER_ERROR");
			expect(rover.context.upstreamStatus).toBe("429");
			expect(rover.context.retryAfter).toBe("30");
			expect(rover.context.providerMessage).toContain("too many transmissions");
		}
	});

	it("leaves retryAfter out when the provider gave no hint", async () => {
		fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));

		try {
			await new SparkPostTransport({ apiKey: "k" }).send(baseMessage());
			expect.unreachable("a 500 has to be reported");
		} catch (error) {
			expect((error as RoverError).context.retryAfter).toBeUndefined();
		}
	});

	it("keeps a secret out of the message it reports", async () => {
		fetchSpy.mockResolvedValue(
			new Response("rejected: Bearer sk_live_supersecret", { status: 401 }),
		);

		try {
			await new SparkPostTransport({ apiKey: "k" }).send(baseMessage());
			expect.unreachable("a 401 has to be reported");
		} catch (error) {
			expect((error as RoverError).context.providerMessage).not.toContain(
				"sk_live_supersecret",
			);
		}
	});

	it("caps a provider message that would otherwise flood the log", async () => {
		fetchSpy.mockResolvedValue(
			new Response("x".repeat(64 * 1024), { status: 500 }),
		);

		try {
			await new SparkPostTransport({ apiKey: "k" }).send(baseMessage());
			expect.unreachable("a 500 has to be reported");
		} catch (error) {
			const message = (error as RoverError).context.providerMessage as string;
			expect(message.length).toBeLessThan(20 * 1024);
			expect(message).toMatch(/\[truncated\]$/);
		}
	});

	it("says the network failed rather than surfacing a fetch error", async () => {
		fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

		await expect(
			new SparkPostTransport({ apiKey: "k" }).send(baseMessage()),
		).rejects.toThrow(/sparkpost/i);
	});
});
