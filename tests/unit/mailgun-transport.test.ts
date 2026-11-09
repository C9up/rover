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
	/** The MIME message posted as the `message` file. */
	const mime = async (): Promise<string> => {
		const file = form().get("message");
		if (!(file instanceof Blob)) throw new Error("no message part");
		return file.text();
	};
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

	it("posts nodemailer's MIME to the domain's messages.mime endpoint", async () => {
		const result = await transport().send(baseMessage());

		expect(url()).toBe(
			"https://api.mailgun.net/v3/mg.example.com/messages.mime",
		);
		expect(form().getAll("to")).toEqual(["user@example.com"]);
		const raw = await mime();
		expect(raw).toMatch(/^From: sender@example.com\r$/m);
		expect(raw).toMatch(/^Subject: Hello\r$/m);
		expect(raw).toContain("<p>Hi</p>");
		expect(result?.providerId).toBe("mg-1@example");
	});

	it("authenticates with HTTP Basic, username `api`", async () => {
		await transport().send(baseMessage());

		const expected = Buffer.from("api:key-1").toString("base64");
		expect(headers().Authorization).toBe(`Basic ${expected}`);
	});

	it("delivers a bcc-only message through `to`, with no Bcc header", async () => {
		await transport().send({
			...baseMessage(),
			to: [],
			bcc: ["hidden@example.com"],
		});

		expect(form().getAll("to")).toEqual(["hidden@example.com"]);
		expect(await mime()).not.toContain("hidden@example.com");
	});

	it("carries cc, bcc, reply-to, custom headers and attachments", async () => {
		await transport().send({
			...baseMessage(),
			cc: ["cc@example.com"],
			bcc: ["bcc@example.com"],
			replyTo: ["reply@example.com"],
			headers: { "X-Campaign": "spring" },
			attachments: [
				{
					filename: "invoice.pdf",
					content: Buffer.from("%PDF-1.4"),
					contentType: "application/pdf",
				},
			],
		});

		expect(form().getAll("to")).toEqual([
			"user@example.com",
			"cc@example.com",
			"bcc@example.com",
		]);
		const raw = await mime();
		expect(raw).toMatch(/^Cc: cc@example.com\r$/m);
		expect(raw).not.toMatch(/^Bcc:/m);
		expect(raw).toMatch(/^Reply-To: reply@example.com\r$/m);
		expect(raw).toMatch(/^X-Campaign: spring\r$/m);
		expect(raw).toContain("filename=invoice.pdf");
		expect(raw).toContain(Buffer.from("%PDF-1.4").toString("base64"));
	});

	it("lets no line break open a header", async () => {
		await transport().send({
			...baseMessage(),
			to: ["user@example.com\r\nBcc: attacker@evil.test"],
			subject: "Hello\r\nX-Injected: 1",
			replyTo: ["reply@example.com\r\n"],
			headers: { "X-Tag": "one\r\ntwo" },
		});

		for (const to of form().getAll("to")) {
			expect(String(to)).not.toMatch(/[\r\n]/);
		}
		const raw = await mime();
		expect(raw).not.toMatch(/^(Bcc|X-Injected):/im);
		expect(raw).not.toMatch(/^two\r$/m);
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

		expect((await transport().send(baseMessage()))?.providerId).toBeUndefined();
	});

	it("routes EU traffic to the EU host, whatever the casing", async () => {
		await transport({ region: "EU" }).send(baseMessage());

		expect(url()).toBe(
			"https://api.eu.mailgun.net/v3/mg.example.com/messages.mime",
		);
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

		expect(url()).toBe(
			"https://api.mailgun.net/v3/mg.example.com/messages.mime",
		);
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
