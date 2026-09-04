/**
 * The SendGrid transport, on the wire.
 *
 * It used to go through `@sendgrid/mail`, whose flat message shape was its own
 * invention — the v3 API groups recipients under `personalizations`, and that
 * is what actually leaves the process. Every assertion here is about that, and
 * about what happens when SendGrid says no.
 */
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "../../src/index.js";
import type { RoverError } from "../../src/RoverError.js";
import { SendGridTransport } from "../../src/transports/SendGridTransport.js";
import { defined } from "../__helpers__/defined.js";

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

interface SendGridBody {
	personalizations: Array<{
		to: Array<{ email: string }>;
		cc?: Array<{ email: string }>;
		bcc?: Array<{ email: string }>;
	}>;
	from: { email: string };
	reply_to?: { email: string };
	subject: string;
	content: Array<{ type: string; value: string }>;
	headers?: Record<string, string>;
	attachments?: Array<{
		filename: string;
		content: string;
		type?: string;
		disposition: string;
	}>;
}

describe("rover > SendGridTransport", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	const body = (): SendGridBody =>
		JSON.parse(
			(fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string,
		) as SendGridBody;
	const headers = (): Record<string, string> =>
		(fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
			string,
			string
		>;
	const url = (): string => String(fetchSpy.mock.calls[0]?.[0]);

	const accepted = (over: HeadersInit = {}) =>
		new Response(null, { status: 202, headers: over });

	beforeEach(() => {
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(accepted({ "x-message-id": "sg-abc-xyz" }));
	});
	afterEach(() => {
		fetchSpy.mockRestore();
	});

	const transport = (over: Record<string, unknown> = {}) =>
		new SendGridTransport({ apiKey: "SG.k", ...over });

	it("posts to the v3 endpoint with the key as a bearer token", async () => {
		const result = await transport().send(baseMessage());

		expect(url()).toBe("https://api.sendgrid.com/v3/mail/send");
		expect(headers().Authorization).toBe("Bearer SG.k");
		expect(body().from.email).toBe("sender@example.com");
		expect(defined(body().personalizations[0]).to).toEqual([
			{ email: "user@example.com" },
		]);
		expect(body().subject).toBe("Hello");
		expect(result).toEqual({ providerId: "sg-abc-xyz" });
	});

	it("groups cc and bcc under the personalization, not at the top level", async () => {
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

		const personalization = defined(body().personalizations[0]);
		expect(personalization.cc).toEqual([{ email: "cc@example.com" }]);
		expect(personalization.bcc).toEqual([{ email: "bcc@example.com" }]);
		expect(body().reply_to).toEqual({ email: "reply@example.com" });
		expect(body().headers).toEqual({ "X-Campaign": "spring" });
		expect(body().attachments?.[0]).toEqual({
			filename: "invoice.pdf",
			content: Buffer.from("%PDF-1.4").toString("base64"),
			type: "application/pdf",
			disposition: "attachment",
		});
	});

	it("emits only the content parts that exist", async () => {
		await transport().send({ ...baseMessage(), text: "" });

		expect(body().content).toEqual([{ type: "text/html", value: "<p>Hi</p>" }]);
	});

	it("emits both parts, plain text first", async () => {
		await transport().send(baseMessage());

		expect(body().content).toEqual([
			{ type: "text/plain", value: "Hi" },
			{ type: "text/html", value: "<p>Hi</p>" },
		]);
	});

	it("strips CRLF everywhere a header could be injected", async () => {
		await transport().send({
			...baseMessage(),
			to: ["user@example.com\r\nBcc: attacker@evil.test"],
			subject: "Hello\r\nX-Injected: 1",
			replyTo: "reply@example.com\r\n",
			headers: { "X-Tag": "one\r\ntwo" },
			attachments: [{ filename: "a\r\nb.pdf", content: Buffer.from("x") }],
		});

		const sent = JSON.stringify(body());
		expect(sent).not.toMatch(/[\r\n]/);
	});

	it("refuses a message with no recipients at all", async () => {
		await expect(
			transport().send({ ...baseMessage(), to: [], cc: [], bcc: [] }),
		).rejects.toThrow(/no recipients/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("wraps a refusal, carrying the status and the body", async () => {
		fetchSpy.mockResolvedValue(
			new Response('{"errors":[{"message":"bad request"}]}', { status: 400 }),
		);

		const error = (await transport()
			.send(baseMessage())
			.catch((e: unknown) => e)) as RoverError;

		expect(error.code).toBe("E_MAIL_PROVIDER_ERROR");
		expect(error.context?.upstreamStatus).toBe("400");
		expect(error.context?.providerMessage).toContain("bad request");
	});

	it("passes Retry-After up so the backoff can honour it", async () => {
		fetchSpy.mockResolvedValue(
			new Response("slow down", {
				status: 429,
				headers: { "retry-after": "17" },
			}),
		);

		const error = (await transport()
			.send(baseMessage())
			.catch((e: unknown) => e)) as RoverError;

		expect(error.context?.retryAfter).toBe("17");
	});

	it("keeps a network failure classifiable for retry", async () => {
		fetchSpy.mockRejectedValue(
			Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
		);

		const error = (await transport()
			.send(baseMessage())
			.catch((e: unknown) => e)) as RoverError;

		expect(error.code).toBe("E_MAIL_PROVIDER_ERROR");
		expect(error.context?.networkCode).toBe("ECONNRESET");
	});

	it("answers no providerId when the response carries no message id", async () => {
		fetchSpy.mockResolvedValue(accepted());

		expect(await transport().send(baseMessage())).toBeUndefined();
	});

	it("refuses to exist without an apiKey", () => {
		expect(() => new SendGridTransport({})).toThrow(/requires apiKey/);
	});

	it("trims whitespace and CRLF out of the key", async () => {
		await new SendGridTransport({ apiKey: " SG.k\r\n" }).send(baseMessage());

		expect(headers().Authorization).toBe("Bearer SG.k");
	});
});
