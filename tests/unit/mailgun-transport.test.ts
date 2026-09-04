/**
 * The Mailgun transport, on the wire.
 *
 * It used to go through `mailgun.js`, which pulled `form-data` in with it —
 * two dependencies for a multipart POST that Node can build itself. Every
 * assertion here is about what leaves the process, and about what happens when
 * Mailgun says no.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import type { RoverError } from "../../src/RoverError.js";
import { MailgunTransport } from "../../src/transports/MailgunTransport.js";
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

describe("rover > MailgunTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	/** The multipart body of the one call made. */
	const form = (): FormData =>
		requestInit(fetchSpy.mock.calls, 0).body as FormData;
	const field = (name: string): string => String(form().get(name) ?? "");
	const url = (): string => String(fetchSpy.mock.calls[0]?.[0]);
	const headers = (): Record<string, string> =>
		requestInit(fetchSpy.mock.calls, 0).headers as Record<string, string>;

	const ok = (body: unknown = { id: "<mg-1@example>", message: "Queued" }) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	const transport = (over: Record<string, unknown> = {}) =>
		new MailgunTransport({
			apiKey: "key-1",
			domain: "mg.example.com",
			...over,
		});

	it("posts the message to the domain's endpoint", async () => {
		const result = await transport().send(baseMessage());

		expect(url()).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
		expect(field("from")).toBe("sender@example.com");
		expect(field("to")).toBe("user@example.com");
		expect(field("subject")).toBe("Hello");
		expect(field("html")).toBe("<p>Hi</p>");
		expect(field("text")).toBe("Hi");
		expect(result).toEqual({ providerId: "<mg-1@example>" });
	});

	it("authenticates with HTTP Basic, username `api`", async () => {
		await transport().send(baseMessage());

		const expected = Buffer.from("api:key-1").toString("base64");
		expect(headers().Authorization).toBe(`Basic ${expected}`);
	});

	it("falls back to the sender for `to` on a bcc-only message", async () => {
		// Mailgun 400s without a `to`, and a bcc-only message is valid — so the
		// envelope carries the sender and the bcc list still receives it.
		await transport().send({
			...baseMessage(),
			to: [],
			bcc: ["hidden@example.com"],
		});

		expect(field("to")).toBe("sender@example.com");
		expect(field("bcc")).toBe("hidden@example.com");
	});

	it("carries cc, bcc, reply-to, custom headers and attachments", async () => {
		await transport().send({
			...baseMessage(),
			cc: ["cc@example.com"],
			bcc: ["bcc@example.com"],
			replyTo: "reply@example.com",
			headers: { "X-Campaign": "spring" },
			attachments: [
				{
					filename: "invoice.pdf",
					content: Buffer.from("%PDF-1.4"),
					contentType: "application/pdf",
				},
			],
		});

		expect(field("cc")).toBe("cc@example.com");
		expect(field("bcc")).toBe("bcc@example.com");
		expect(field("h:Reply-To")).toBe("reply@example.com");
		expect(field("h:X-Campaign")).toBe("spring");

		const attachment = form().get("attachment");
		expect(attachment).toBeInstanceOf(Blob);
		if (attachment instanceof File) {
			expect(attachment.name).toBe("invoice.pdf");
			expect(attachment.type).toBe("application/pdf");
			expect(await attachment.text()).toBe("%PDF-1.4");
		}
	});

	it("strips CRLF everywhere a header could be injected", async () => {
		await transport().send({
			...baseMessage(),
			to: ["user@example.com\r\nBcc: attacker@evil.test"],
			subject: "Hello\r\nX-Injected: 1",
			replyTo: "reply@example.com\r\n",
			headers: { "X-Tag": "one\r\ntwo" },
		});

		for (const name of ["to", "subject", "h:Reply-To", "h:X-Tag"]) {
			expect(field(name)).not.toMatch(/[\r\n]/);
		}
	});

	it("refuses a message with no recipients at all", async () => {
		await expect(
			transport().send({ ...baseMessage(), to: [], cc: [], bcc: [] }),
		).rejects.toThrow(/no recipients/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("wraps a refusal, carrying the status and the body", async () => {
		fetchSpy.mockResolvedValue(
			new Response("Forbidden — domain not verified", { status: 403 }),
		);

		const error = (await transport()
			.send(baseMessage())
			.catch((e: unknown) => e)) as RoverError;

		expect(error.code).toBe("E_MAIL_PROVIDER_ERROR");
		expect(error.context?.upstreamStatus).toBe("403");
		expect(error.context?.providerMessage).toContain("not verified");
	});

	it("passes Retry-After up so the backoff can honour it", async () => {
		fetchSpy.mockResolvedValue(
			new Response("slow down", {
				status: 429,
				headers: { "retry-after": "42" },
			}),
		);

		const error = (await transport()
			.send(baseMessage())
			.catch((e: unknown) => e)) as RoverError;

		expect(error.context?.retryAfter).toBe("42");
	});

	it("keeps a network failure classifiable for retry", async () => {
		const refused = Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		});
		fetchSpy.mockRejectedValue(refused);

		const error = (await transport()
			.send(baseMessage())
			.catch((e: unknown) => e)) as RoverError;

		expect(error.code).toBe("E_MAIL_PROVIDER_ERROR");
		expect(error.context?.networkCode).toBe("ECONNREFUSED");
	});

	it("answers no providerId when the response carries none", async () => {
		fetchSpy.mockResolvedValue(ok({ message: "Queued" }));

		expect(await transport().send(baseMessage())).toBeUndefined();
	});

	it("routes EU traffic to the EU host, whatever the casing", async () => {
		await transport({ region: "EU" }).send(baseMessage());

		expect(url()).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
	});

	it("refuses a region it does not know, rather than defaulting to US", async () => {
		// Silently routing EU traffic to US infrastructure is a compliance
		// problem, not a typo to paper over.
		expect(() => transport({ region: "fr" })).toThrow(/must be "us" or "eu"/);
		expect(() => transport({ region: 42 })).toThrow(/must be a string/);
	});

	it("trims whitespace and CRLF out of the config", async () => {
		await new MailgunTransport({
			apiKey: " key-1\r\n",
			domain: " mg.example.com ",
		}).send(baseMessage());

		expect(url()).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
		expect(headers().Authorization).toBe(
			`Basic ${Buffer.from("api:key-1").toString("base64")}`,
		);
	});

	it("refuses to exist without an apiKey or a domain", () => {
		expect(() => new MailgunTransport({ domain: "d" })).toThrow(
			/requires apiKey and domain/,
		);
		expect(() => new MailgunTransport({ apiKey: "k" })).toThrow(
			/requires apiKey and domain/,
		);
	});
});
