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
	content: {
		from: string;
		subject: string;
		html?: string;
		text?: string;
		reply_to?: string;
		headers?: Record<string, string>;
		attachments?: Array<{ name: string; type: string; data: string }>;
	};
	recipients: Array<{ address: { email: string; name?: string } }>;
}

describe("rover > SparkPostTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	const body = (): SparkPostBody =>
		JSON.parse(
			(fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
		) as SparkPostBody;
	const headers = () =>
		(fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
			string,
			string
		>;

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

	it("splits a formatted address into SparkPost's address shape", async () => {
		const message = baseMessage();
		message.to = ['"Ada Lovelace" <ada@acme.test>', "bare@acme.test"];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().recipients).toEqual([
			{ address: { email: "ada@acme.test", name: "Ada Lovelace" } },
			{ address: { email: "bare@acme.test" } },
		]);
	});

	it("folds cc and bcc into the recipient list, so they are delivered", async () => {
		const message = baseMessage();
		message.cc = ["cc@acme.test"];
		message.bcc = ["bcc@acme.test"];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		// `recipients` is the only delivery list SparkPost reads — anything not
		// in it is silently never sent.
		expect(body().recipients.map((r) => r.address.email)).toEqual([
			"user@example.com",
			"cc@acme.test",
			"bcc@acme.test",
		]);
	});

	it("surfaces cc as a header, and never bcc", async () => {
		const message = baseMessage();
		message.cc = ["cc@acme.test", "cc2@acme.test"];
		message.bcc = ["bcc@acme.test"];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		// A bcc that reaches a header stops being blind.
		expect(body().content.headers?.CC).toBe("cc@acme.test, cc2@acme.test");
		expect(JSON.stringify(body().content.headers)).not.toContain(
			"bcc@acme.test",
		);
	});

	it("omits the header block entirely when there is nothing to put in it", async () => {
		await new SparkPostTransport({ apiKey: "k" }).send(baseMessage());

		expect(body().content.headers).toBeUndefined();
	});

	it("carries reply-to, html and text through", async () => {
		const message = baseMessage();
		message.replyTo = "reply@acme.test";
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().content.reply_to).toBe("reply@acme.test");
		expect(body().content.html).toBe("<p>Hi</p>");
		expect(body().content.text).toBe("Hi");
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

	it("strips line terminators out of everything it copies", async () => {
		const message = baseMessage();
		message.subject = "Hello\r\nBcc: attacker@evil.test";
		message.from = "sender@example.com\r\n";
		message.headers = { "X-Tag": "one\r\ntwo" };
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().content.subject).not.toMatch(/[\r\n]/);
		expect(body().content.from).not.toMatch(/[\r\n]/);
		expect(body().content.headers?.["X-Tag"]).not.toMatch(/[\r\n]/);
	});

	it("joins a multi-valued header rather than dropping one", async () => {
		const message = baseMessage();
		message.headers = { "X-Tag": ["a", "b"] };
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().content.headers?.["X-Tag"]).toBe("a, b");
	});

	it("base64-encodes attachments, with a type when the caller gave none", async () => {
		const message = baseMessage();
		message.attachments = [
			{ filename: "note.txt", content: Buffer.from("hello") },
			{
				filename: "doc.pdf",
				content: Buffer.from("%PDF"),
				contentType: "application/pdf",
			},
		];
		await new SparkPostTransport({ apiKey: "k" }).send(message);

		expect(body().content.attachments).toEqual([
			{
				name: "note.txt",
				type: "application/octet-stream",
				data: Buffer.from("hello").toString("base64"),
			},
			{
				name: "doc.pdf",
				type: "application/pdf",
				data: Buffer.from("%PDF").toString("base64"),
			},
		]);
	});

	it("hands back the transmission id", async () => {
		expect(
			await new SparkPostTransport({ apiKey: "k" }).send(baseMessage()),
		).toEqual({ providerId: "11668787484950529" });
	});

	it("falls back to a generated id when the body carries none", async () => {
		fetchSpy.mockResolvedValue(new Response("", { status: 200 }));

		expect(
			await new SparkPostTransport({ apiKey: "k" }).send(baseMessage()),
		).toBeUndefined();
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
