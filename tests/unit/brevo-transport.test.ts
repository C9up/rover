/**
 * The Brevo transport.
 *
 * It shipped with nothing exercising it, which for a transport means the first
 * time the code runs is against a customer's provider. Every assertion here is
 * about what goes on the wire, and about what happens when Brevo says no.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import type { RoverError } from "../../src/RoverError.js";
import { BrevoTransport } from "../../src/transports/BrevoTransport.js";
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

interface BrevoBody {
	sender: { email: string; name?: string };
	to: Array<{ email: string; name?: string }>;
	cc?: Array<{ email: string }>;
	bcc?: Array<{ email: string }>;
	replyTo?: { email: string };
	subject: string;
	htmlContent?: string;
	textContent?: string;
	headers?: Record<string, string>;
	attachment?: Array<{ name: string; content: string }>;
}

describe("rover > BrevoTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	const body = (): BrevoBody =>
		JSON.parse(requestInit(fetchSpy.mock.calls, 0).body as string) as BrevoBody;
	const headers = () =>
		requestInit(fetchSpy.mock.calls, 0).headers as Record<string, string>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ messageId: "<abc@brevo>" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("refuses to exist without an API key", () => {
		expect(() => new BrevoTransport({})).toThrow(/requires apiKey/);
	});

	it("takes the key under either spelling", async () => {
		await new BrevoTransport({ key: "k-1" }).send(baseMessage());
		expect(headers()["api-key"]).toBe("k-1");
	});

	it("posts to the transactional endpoint with the key as a header", async () => {
		await new BrevoTransport({ apiKey: "k-1" }).send(baseMessage());

		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://api.brevo.com/v3/smtp/email",
		);
		expect(headers()["Content-Type"]).toBe("application/json");
	});

	it("takes a base URL, trailing slashes and all", async () => {
		await new BrevoTransport({
			apiKey: "k",
			baseUrl: "https://proxy.acme.test///",
		}).send(baseMessage());

		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"https://proxy.acme.test/v3/smtp/email",
		);
	});

	it("splits a formatted address into Brevo's contact shape", async () => {
		const message = baseMessage();
		message.from = '"Ada Lovelace" <ada@acme.test>';
		message.to = ["Grace Hopper <grace@acme.test>", "bare@acme.test"];
		await new BrevoTransport({ apiKey: "k" }).send(message);

		expect(body().sender).toEqual({
			email: "ada@acme.test",
			name: "Ada Lovelace",
		});
		expect(body().to).toEqual([
			{ email: "grace@acme.test", name: "Grace Hopper" },
			{ email: "bare@acme.test" },
		]);
	});

	it("carries cc, bcc and reply-to only when they are set", async () => {
		await new BrevoTransport({ apiKey: "k" }).send(baseMessage());
		expect(body().cc).toBeUndefined();
		expect(body().bcc).toBeUndefined();
		expect(body().replyTo).toBeUndefined();

		fetchSpy.mockClear();
		const message = baseMessage();
		message.cc = ["cc@acme.test"];
		message.bcc = ["bcc@acme.test"];
		message.replyTo = "reply@acme.test";
		await new BrevoTransport({ apiKey: "k" }).send(message);

		expect(body().cc).toEqual([{ email: "cc@acme.test" }]);
		expect(body().bcc).toEqual([{ email: "bcc@acme.test" }]);
		expect(body().replyTo).toEqual({ email: "reply@acme.test" });
	});

	it("addresses a bcc-only message to the sender, so Brevo accepts it", async () => {
		const message = baseMessage();
		message.to = [];
		message.bcc = ["hidden@acme.test"];
		await new BrevoTransport({ apiKey: "k" }).send(message);

		// A message with no visible recipient is refused outright by the API.
		expect(body().to).toEqual([{ email: "sender@example.com" }]);
		expect(body().bcc).toEqual([{ email: "hidden@acme.test" }]);
	});

	it("refuses a message addressed to nobody at all", async () => {
		const message = baseMessage();
		message.to = [];

		await expect(
			new BrevoTransport({ apiKey: "k" }).send(message),
		).rejects.toThrow(/no recipients/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("strips line terminators out of everything it copies", async () => {
		const message = baseMessage();
		message.subject = "Hello\r\nBcc: attacker@evil.test";
		message.headers = { "X-Tag": "one\r\ntwo" };
		await new BrevoTransport({ apiKey: "k" }).send(message);

		// A newline that survives into a header is a header the sender did not
		// write.
		expect(body().subject).not.toMatch(/[\r\n]/);
		expect(body().headers?.["X-Tag"]).not.toMatch(/[\r\n]/);
	});

	it("joins a multi-valued header rather than dropping one", async () => {
		const message = baseMessage();
		message.headers = { "X-Tag": ["a", "b"] };
		await new BrevoTransport({ apiKey: "k" }).send(message);

		expect(body().headers?.["X-Tag"]).toBe("a, b");
	});

	it("base64-encodes attachments", async () => {
		const message = baseMessage();
		message.attachments = [
			{ filename: "note.txt", content: Buffer.from("hello") },
		];
		await new BrevoTransport({ apiKey: "k" }).send(message);

		expect(body().attachment).toEqual([
			{ name: "note.txt", content: Buffer.from("hello").toString("base64") },
		]);
	});

	it("hands back the provider's own message id", async () => {
		const outcome = await new BrevoTransport({ apiKey: "k" }).send(
			baseMessage(),
		);

		expect(outcome).toEqual({ providerId: "<abc@brevo>" });
	});

	it("falls back to a generated id when the body carries none", async () => {
		fetchSpy.mockResolvedValue(new Response("", { status: 201 }));

		expect(
			await new BrevoTransport({ apiKey: "k" }).send(baseMessage()),
		).toBeUndefined();
	});

	it("carries the status and the backoff hint on a refusal", async () => {
		fetchSpy.mockResolvedValue(
			new Response("rate limited", {
				status: 429,
				headers: { "retry-after": "30" },
			}),
		);

		try {
			await new BrevoTransport({ apiKey: "k" }).send(baseMessage());
			expect.unreachable("a 429 has to be reported");
		} catch (error) {
			const rover = error as RoverError;
			// Retry eligibility is decided from these, so they are the payload.
			expect(rover.code).toBe("E_MAIL_PROVIDER_ERROR");
			expect(rover.context.upstreamStatus).toBe("429");
			expect(rover.context.retryAfter).toBe("30");
			expect(rover.context.providerMessage).toContain("rate limited");
		}
	});

	it("keeps a secret out of the message it reports", async () => {
		fetchSpy.mockResolvedValue(
			new Response("bad key: Bearer sk_live_supersecret", { status: 401 }),
		);

		try {
			await new BrevoTransport({ apiKey: "k" }).send(baseMessage());
			expect.unreachable("a 401 has to be reported");
		} catch (error) {
			// The provider echoes the request back; the error travels into logs.
			expect((error as RoverError).context.providerMessage).not.toContain(
				"sk_live_supersecret",
			);
		}
	});

	it("says the network failed rather than surfacing a fetch error", async () => {
		fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

		await expect(
			new BrevoTransport({ apiKey: "k" }).send(baseMessage()),
		).rejects.toThrow(/brevo/i);
	});
});
